"""Unit tests for litellm.types.router config models."""

from litellm.types.router import RetryPolicy, UpdateRouterConfig


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
