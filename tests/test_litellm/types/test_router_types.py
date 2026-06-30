"""Unit tests for litellm.types.router config models."""

import pytest
from pydantic import ValidationError

from litellm.types.router import RetryPolicy, RoutingGroup, UpdateRouterConfig


def test_update_router_config_rejects_routing_groups_json_string():
    """A JSON *string* like "[]" must not be accepted for routing_groups.

    The Admin UI used to render this List field as a text input and POST its
    value as the string "[]". Pydantic rejected it with a ``list_type`` error,
    which made FastAPI 422 the whole router_settings body and silently dropped
    every other Reliability & Retries value. Pin the strict behaviour so the
    contract the UI must satisfy stays explicit.
    """
    with pytest.raises(ValidationError) as exc_info:
        UpdateRouterConfig(routing_groups="[]")

    assert any(
        err["loc"] == ("routing_groups",) and err["type"] == "list_type"
        for err in exc_info.value.errors()
    )


def test_update_router_config_accepts_empty_routing_groups_list():
    """An actual empty list (what the fixed UI now sends) is valid."""
    cfg = UpdateRouterConfig(routing_groups=[])

    assert cfg.routing_groups == []


def test_update_router_config_parses_routing_groups_entries():
    """Populated routing_groups are coerced into RoutingGroup models."""
    cfg = UpdateRouterConfig(
        routing_groups=[
            {
                "group_name": "group-a",
                "models": ["gpt-4"],
                "routing_strategy": "simple-shuffle",
            }
        ]
    )

    assert cfg.routing_groups is not None
    assert len(cfg.routing_groups) == 1
    assert isinstance(cfg.routing_groups[0], RoutingGroup)
    assert cfg.routing_groups[0].group_name == "group-a"
    assert cfg.routing_groups[0].models == ["gpt-4"]


def test_update_router_config_retains_retry_policy():
    """UpdateRouterConfig must parse retry_policy into RetryPolicy and serialize it back out."""
    cfg = UpdateRouterConfig(
        retry_policy={"RateLimitErrorRetries": 3, "InternalServerErrorRetries": 5}
    )

    assert isinstance(cfg.retry_policy, RetryPolicy)
    assert cfg.retry_policy.RateLimitErrorRetries == 3
    assert cfg.retry_policy.InternalServerErrorRetries == 5

    serialized = cfg.dict(exclude_none=True)
    assert serialized["retry_policy"] == {
        "RateLimitErrorRetries": 3,
        "InternalServerErrorRetries": 5,
    }


def test_update_router_config_retry_policy_defaults_to_none():
    """retry_policy is optional and absent from exclude_none serialization."""
    cfg = UpdateRouterConfig()

    assert cfg.retry_policy is None
    assert "retry_policy" not in cfg.dict(exclude_none=True)
