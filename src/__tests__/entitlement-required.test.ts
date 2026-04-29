// Unit tests for the runner CLI's "Pro required" gate detection. The server
// returns 403 + `error: "entitlement_required"` when a free user tries to
// start an AI-Assisted session via the runner; the CLI must detect that
// specific shape and surface a friendly upgrade message instead of leaking
// a raw HTTP error.
import test from "node:test";
import assert from "node:assert/strict";
import {
  isEntitlementRequiredError,
  formatEntitlementRequiredMessage,
  type EntitlementRequiredErrorBody,
} from "../ai-assisted/cli-start.js";
import { ApiError } from "../api.js";

test("isEntitlementRequiredError: matches 403 ApiError with entitlement_required body", () => {
  const err = new ApiError(
    403,
    {
      error: "entitlement_required",
      currentEntitlement: "free",
      requiredEntitlement: "pro",
      message: "AI-Assisted sessions require a PrepSavant Pro or Lifetime plan.",
    },
    "POST /api/runner/sessions → 403",
  );
  assert.equal(isEntitlementRequiredError(err), true);
});

test("isEntitlementRequiredError: rejects 403 with a different error code", () => {
  const err = new ApiError(
    403,
    { error: "forbidden" },
    "POST /api/runner/sessions → 403",
  );
  assert.equal(isEntitlementRequiredError(err), false);
});

test("isEntitlementRequiredError: rejects non-403 statuses", () => {
  const err = new ApiError(
    401,
    { error: "entitlement_required" },
    "POST /api/runner/sessions → 401",
  );
  assert.equal(isEntitlementRequiredError(err), false);
});

test("isEntitlementRequiredError: rejects non-ApiError throwables", () => {
  assert.equal(isEntitlementRequiredError(new Error("boom")), false);
  assert.equal(isEntitlementRequiredError("nope"), false);
  assert.equal(isEntitlementRequiredError(null), false);
  assert.equal(isEntitlementRequiredError(undefined), false);
});

test("isEntitlementRequiredError: rejects 403 with non-object body", () => {
  const err = new ApiError(403, "forbidden", "GET / → 403");
  assert.equal(isEntitlementRequiredError(err), false);
});

test("formatEntitlementRequiredMessage: includes the upgrade URL for the configured API base", () => {
  const body: EntitlementRequiredErrorBody = {
    error: "entitlement_required",
    currentEntitlement: "free",
    requiredEntitlement: "pro",
  };
  const msg = formatEntitlementRequiredMessage("https://prepsavant.com", body);
  assert.match(msg, /AI-Assisted requires PrepSavant Pro/);
  assert.match(msg, /Upgrade at: https:\/\/prepsavant\.com\/pricing/);
});

test("formatEntitlementRequiredMessage: trims trailing slash on the base URL", () => {
  const body: EntitlementRequiredErrorBody = {
    error: "entitlement_required",
    requiredEntitlement: "pro",
  };
  const msg = formatEntitlementRequiredMessage(
    "https://staging.prepsavant.com/",
    body,
  );
  assert.match(msg, /https:\/\/staging\.prepsavant\.com\/pricing/);
  assert.equal(msg.includes("//pricing"), false);
});

test("formatEntitlementRequiredMessage: labels the tier as Lifetime when required", () => {
  const body: EntitlementRequiredErrorBody = {
    error: "entitlement_required",
    requiredEntitlement: "lifetime",
  };
  const msg = formatEntitlementRequiredMessage("https://prepsavant.com", body);
  assert.match(msg, /AI-Assisted requires PrepSavant Lifetime/);
});
