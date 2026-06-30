"""Functional + contract tests for POST /config/update router_settings.

Regression coverage for the bug where the Admin UI's "Reliability & Retries"
form serialized the ``routing_groups`` List field as the JSON *string* ``"[]"``
and POSTed it to ``/config/update``. FastAPI validated the body against
``ConfigYAML`` and rejected the string with a ``list_type`` error, returning a
422 for the *entire* router_settings payload — silently dropping every other
field in the section (allowed_fails, cooldown_time, timeout, ...).

The UI fix sends a real list; these tests pin both the rejection of the old
(string) shape and the acceptance + persistence of the new (list) shape.
"""

from __future__ import annotations

import json
from unittest.mock import AsyncMock, MagicMock

import pytest
from pydantic import ValidationError

from litellm.proxy import proxy_server
from litellm.proxy._types import ConfigYAML, LitellmUserRoles

# ---------------------------------------------------------------------------
# Body-model contract (what FastAPI validates before the handler runs)
# ---------------------------------------------------------------------------


def test_config_yaml_rejects_routing_groups_string():
    """ConfigYAML.router_settings.routing_groups rejects a JSON string."""
    with pytest.raises(ValidationError) as exc_info:
        ConfigYAML(router_settings={"routing_groups": "[]"})

    assert any(
        err["loc"][-2:] == ("router_settings", "routing_groups")
        and err["type"] == "list_type"
        for err in exc_info.value.errors()
    )


def test_config_yaml_accepts_routing_groups_list():
    """An empty list plus a sibling numeric field validate cleanly."""
    cfg = ConfigYAML(router_settings={"routing_groups": [], "num_retries": 3})

    assert cfg.router_settings is not None
    assert cfg.router_settings.routing_groups == []
    assert cfg.router_settings.num_retries == 3


# ---------------------------------------------------------------------------
# HTTP layer — reproduces the reported 422 and proves the fix is accepted
# ---------------------------------------------------------------------------


def test_config_update_rejects_routing_groups_string_returns_422(client, auth_as):
    """POST /config/update with routing_groups="[]" -> 422 (the reported bug).

    Validation fails before the handler, so no DB is required.
    """
    with auth_as(LitellmUserRoles.PROXY_ADMIN):
        response = client.post(
            "/config/update",
            json={"router_settings": {"routing_groups": "[]"}},
        )

    assert response.status_code == 422
    detail = response.json()["detail"]
    assert isinstance(detail, list)
    assert any(
        err.get("type") == "list_type" and err.get("loc", [])[-1] == "routing_groups"
        for err in detail
    )


def test_config_update_accepts_routing_groups_list(
    client, auth_as, mock_prisma, monkeypatch
):
    """POST /config/update with routing_groups=[] -> 200 and persists a list.

    The serialized router_settings written to the config table must contain a
    real list for routing_groups, never the string "[]".
    """
    config_table = MagicMock()
    config_table.find_first = AsyncMock(return_value=None)
    config_table.upsert = AsyncMock()
    mock_prisma.db.litellm_config = config_table

    monkeypatch.setattr(proxy_server, "prisma_client", mock_prisma)
    monkeypatch.setattr(proxy_server, "invalidate_config_param", AsyncMock())
    monkeypatch.setattr(proxy_server.proxy_config, "add_deployment", AsyncMock())

    with auth_as(LitellmUserRoles.PROXY_ADMIN):
        response = client.post(
            "/config/update",
            json={"router_settings": {"routing_groups": [], "num_retries": 3}},
        )

    assert response.status_code == 200

    # Locate the router_settings upsert and decode the persisted value.
    persisted = None
    for call in config_table.upsert.await_args_list:
        if call.kwargs.get("where", {}).get("param_name") == "router_settings":
            persisted = json.loads(call.kwargs["data"]["create"]["param_value"])

    assert persisted is not None, "router_settings was never upserted"
    assert persisted["routing_groups"] == []
    assert isinstance(persisted["routing_groups"], list)
    assert persisted["num_retries"] == 3


def test_config_update_persists_full_reliability_payload(
    client, auth_as, mock_prisma, monkeypatch
):
    """Backward compatibility: a realistic Reliability & Retries payload (no
    routing_groups) still returns 200 and persists every field.

    The reported symptom was "none of these values save". This proves the
    common case — the full set of fields the section sends — round-trips
    intact through /config/update.
    """
    config_table = MagicMock()
    config_table.find_first = AsyncMock(return_value=None)
    config_table.upsert = AsyncMock()
    mock_prisma.db.litellm_config = config_table

    monkeypatch.setattr(proxy_server, "prisma_client", mock_prisma)
    monkeypatch.setattr(proxy_server, "invalidate_config_param", AsyncMock())
    monkeypatch.setattr(proxy_server.proxy_config, "add_deployment", AsyncMock())

    payload = {
        "allowed_fails": 5,
        "cooldown_time": 30.0,
        "num_retries": 2,
        "timeout": 60.0,
        "retry_after": 1,
        "retry_policy": {"RateLimitErrorRetries": 3},
    }

    with auth_as(LitellmUserRoles.PROXY_ADMIN):
        response = client.post(
            "/config/update",
            json={"router_settings": payload},
        )

    assert response.status_code == 200

    persisted = None
    for call in config_table.upsert.await_args_list:
        if call.kwargs.get("where", {}).get("param_name") == "router_settings":
            persisted = json.loads(call.kwargs["data"]["create"]["param_value"])

    assert persisted is not None, "router_settings was never upserted"
    for key, value in payload.items():
        assert persisted[key] == value, f"{key} did not round-trip"
