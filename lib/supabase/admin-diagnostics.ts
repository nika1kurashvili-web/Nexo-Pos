// Only fixed labels/booleans/lengths may leave this helper. Never return inputs.
export function adminConfigDiagnostics(
  url: string | undefined,
  anon: string | undefined,
  service: string | undefined,
  publicConfigValid: boolean,
) {
  let urlParses = false;
  try { if (url) { new URL(url); urlParses = true; } } catch { /* No raw error. */ }
  const trimmed = service?.trim() ?? "";
  return {
    urlPresent: Boolean(url), anonKeyPresent: Boolean(anon),
    serviceKeyPresent: Boolean(service),
    serviceKeyTrimmedLength: trimmed.length,
    serviceKeyHasOuterWhitespace: service !== undefined && service !== trimmed,
    serviceKeyHasInternalWhitespace: /\s/.test(trimmed),
    urlParses, publicConfigValid,
  };
}

export function employeeAdminFailure(
  stage: "provisioning_version" | "auth_create",
) {
  // Do not accept SDK errors: even error.message can contain sensitive inputs.
  console.error("[nexo-pos-employee-admin]", JSON.stringify({ category: stage, outcome: "failed" }));
}
