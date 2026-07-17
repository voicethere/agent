/**
 * Sandbox probe: fetch a public HTTPS URL (default google.com).
 * Prints FETCH_OK / FETCH_FAIL for the parent test.
 */
const url = process.env.FETCH_URL ?? "https://www.google.com/";

try {
  const response = await fetch(url, {
    method: "GET",
    redirect: "follow",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const text = await response.text();
  if (text.length < 100) {
    throw new Error(`unexpected body length: ${text.length}`);
  }
  process.stdout.write("FETCH_OK\n");
  process.exit(0);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const code =
    error && typeof error === "object" && "code" in error
      ? String(error.code)
      : "";
  process.stderr.write(`FETCH_FAIL ${code} ${message}\n`);
  process.exit(1);
}
