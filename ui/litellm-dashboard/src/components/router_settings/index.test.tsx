import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders, screen, waitFor } from "../../../tests/test-utils";
import userEvent from "@testing-library/user-event";
import RouterSettings from "./index";

vi.mock("antd", async (importOriginal) => {
  const actual = await importOriginal<typeof import("antd")>();
  return {
    ...actual,
    Select: Object.assign(
      ({ value, onChange, children }: any) => (
        <select
          data-testid="strategy-select"
          value={value ?? ""}
          onChange={(e) => onChange(e.target.value)}
        >
          {children}
        </select>
      ),
      {
        Option: ({ value, children }: any) => (
          <option value={value}>{children}</option>
        ),
      }
    ),
  };
});

vi.mock("@/components/networking", () => ({
  getCallbacksCall: vi.fn(),
  getRouterSettingsCall: vi.fn(),
  setCallbacksCall: vi.fn(),
}));

import {
  getCallbacksCall,
  getRouterSettingsCall,
  setCallbacksCall,
} from "@/components/networking";
import NotificationsManager from "@/components/molecules/notifications_manager";

const mockCallbacksResponse = {
  router_settings: {
    routing_strategy: "simple-shuffle",
    num_retries: 3,
    timeout: 30,
  },
};

const mockRouterSettingsResponse = {
  fields: [
    {
      field_name: "routing_strategy",
      ui_field_name: "Routing Strategy",
      field_description: "How requests are distributed",
      options: ["simple-shuffle", "latency-based-routing"],
      link: null,
    },
    {
      field_name: "enable_tag_filtering",
      ui_field_name: "Tag Filtering",
      field_description: "Route by tag",
      field_value: false,
      link: null,
    },
  ],
  routing_strategy_descriptions: {
    "simple-shuffle": "Randomly pick a deployment",
    "latency-based-routing": "Pick the lowest-latency deployment",
  },
};

const defaultProps = {
  accessToken: "test-token",
  userRole: "Admin",
  userID: "user-1",
  modelData: null,
};

describe("RouterSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getCallbacksCall).mockResolvedValue(mockCallbacksResponse);
    vi.mocked(getRouterSettingsCall).mockResolvedValue(mockRouterSettingsResponse);
    vi.mocked(setCallbacksCall).mockResolvedValue({});
  });

  it("should render nothing when accessToken is null", () => {
    const { container } = renderWithProviders(
      <RouterSettings {...defaultProps} accessToken={null} />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("should render the Save Changes and Reset buttons when authenticated", () => {
    renderWithProviders(<RouterSettings {...defaultProps} />);
    expect(screen.getByRole("button", { name: /save changes/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /reset/i })).toBeInTheDocument();
  });

  it("should fetch callbacks and router settings on mount", async () => {
    renderWithProviders(<RouterSettings {...defaultProps} />);

    await waitFor(() => {
      expect(getCallbacksCall).toHaveBeenCalledWith("test-token", "user-1", "Admin");
    });
    expect(getRouterSettingsCall).toHaveBeenCalledWith("test-token");
  });

  it("should not fetch data when any required prop is missing", () => {
    renderWithProviders(
      <RouterSettings {...defaultProps} userRole={null} />
    );
    expect(getCallbacksCall).not.toHaveBeenCalled();
  });

  it("should render routing strategies loaded from the API", async () => {
    renderWithProviders(<RouterSettings {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByTestId("strategy-select")).toBeInTheDocument();
    });

    const select = screen.getByTestId("strategy-select") as HTMLSelectElement;
    const optionValues = Array.from(select.options).map((o) => o.value);
    expect(optionValues).toContain("simple-shuffle");
    expect(optionValues).toContain("latency-based-routing");
  });

  it("should call setCallbacksCall with updated settings on Save Changes", async () => {
    const user = userEvent.setup();
    renderWithProviders(<RouterSettings {...defaultProps} />);

    // Wait for the strategy select to appear — it only renders after getRouterSettingsCall resolves
    await waitFor(() => {
      expect(screen.getByTestId("strategy-select")).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /save changes/i }));

    expect(setCallbacksCall).toHaveBeenCalledWith(
      "test-token",
      expect.objectContaining({
        router_settings: expect.objectContaining({
          routing_strategy: "simple-shuffle",
        }),
      })
    );
  });

  it("should show a success notification after saving", async () => {
    const user = userEvent.setup();
    renderWithProviders(<RouterSettings {...defaultProps} />);

    // Wait for data to load before interacting
    await waitFor(() => {
      expect(screen.getByTestId("strategy-select")).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => {
      expect(NotificationsManager.success).toHaveBeenCalledWith(
        "router settings updated successfully"
      );
    });
  });

  it("should send list-typed settings as arrays, not JSON strings", async () => {
    // Reproduces the 422 reported on /config/update: routing_groups (a List
    // field) was rendered as the text input "[]" and sent back as the string
    // "[]", which the backend rejected ("Input should be a valid list"),
    // silently dropping every other Reliability & Retries value.
    vi.mocked(getCallbacksCall).mockResolvedValue({
      router_settings: {
        routing_strategy: "simple-shuffle",
        num_retries: 3,
        routing_groups: [{ group_name: "group-a", models: ["gpt-4"], routing_strategy: "simple-shuffle" }],
      },
    });

    const user = userEvent.setup();
    renderWithProviders(<RouterSettings {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByRole("textbox", { name: /routing_groups/i })).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => {
      expect(setCallbacksCall).toHaveBeenCalled();
    });

    const payload = vi.mocked(setCallbacksCall).mock.calls[0][1] as {
      router_settings: Record<string, unknown>;
    };
    const sentRoutingGroups = payload.router_settings.routing_groups;
    expect(Array.isArray(sentRoutingGroups)).toBe(true);
    expect(sentRoutingGroups).toEqual([
      { group_name: "group-a", models: ["gpt-4"], routing_strategy: "simple-shuffle" },
    ]);
    // num_retries must still be coerced to a number, not left as "3".
    expect(payload.router_settings.num_retries).toBe(3);
  });

  it("should surface the backend error and not show success when saving fails", async () => {
    vi.mocked(setCallbacksCall).mockRejectedValueOnce(new Error("Input should be a valid list"));

    const user = userEvent.setup();
    renderWithProviders(<RouterSettings {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByTestId("strategy-select")).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => {
      expect(NotificationsManager.fromBackend).toHaveBeenCalled();
    });
    expect(NotificationsManager.success).not.toHaveBeenCalled();
  });

  // Backward-compatibility regression tests. The fix refactored
  // parseInputValue (introducing field_type-aware helpers). These pin the
  // serialization behavior of the field types that already worked BEFORE the
  // change, so the refactor cannot silently alter them.
  describe("backward compatibility — existing field types still serialize correctly", () => {
    const saveAndGetPayload = async () => {
      const user = userEvent.setup();
      renderWithProviders(<RouterSettings {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByRole("button", { name: /save changes/i })).toBeInTheDocument();
      });
      await user.click(screen.getByRole("button", { name: /save changes/i }));
      await waitFor(() => {
        expect(setCallbacksCall).toHaveBeenCalled();
      });
      return (vi.mocked(setCallbacksCall).mock.calls[0][1] as { router_settings: Record<string, unknown> })
        .router_settings;
    };

    it("should still coerce number fields to numbers, not strings", async () => {
      vi.mocked(getCallbacksCall).mockResolvedValue({
        router_settings: { routing_strategy: "simple-shuffle", num_retries: 5, timeout: 42 },
      });

      const sent = await saveAndGetPayload();

      expect(sent.num_retries).toBe(5);
      expect(typeof sent.num_retries).toBe("number");
      expect(sent.timeout).toBe(42);
      expect(typeof sent.timeout).toBe("number");
    });

    it("should still parse retry_policy back into an object", async () => {
      vi.mocked(getCallbacksCall).mockResolvedValue({
        router_settings: {
          routing_strategy: "simple-shuffle",
          retry_policy: { RateLimitErrorRetries: 2, InternalServerErrorRetries: 5 },
        },
      });

      const sent = await saveAndGetPayload();

      expect(sent.retry_policy).toEqual({
        RateLimitErrorRetries: 2,
        InternalServerErrorRetries: 5,
      });
    });

    it("should still parse model_group_alias back into an object", async () => {
      vi.mocked(getCallbacksCall).mockResolvedValue({
        router_settings: {
          routing_strategy: "simple-shuffle",
          model_group_alias: { "gpt-4": "azure-gpt-4" },
        },
      });

      const sent = await saveAndGetPayload();

      expect(sent.model_group_alias).toEqual({ "gpt-4": "azure-gpt-4" });
    });

    it("should still convert boolean-valued fields to booleans", async () => {
      vi.mocked(getCallbacksCall).mockResolvedValue({
        router_settings: { routing_strategy: "simple-shuffle", set_verbose: true },
      });

      const sent = await saveAndGetPayload();

      expect(sent.set_verbose).toBe(true);
      expect(typeof sent.set_verbose).toBe("boolean");
    });
  });
});
