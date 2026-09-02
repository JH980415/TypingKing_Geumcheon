import assert from "node:assert/strict";
import test from "node:test";

test("resolves only loopback hosts and decimal unprivileged ports", async () => {
  const originalExitCode = process.exitCode;
  try {
    process.exitCode = 0;
    const cli = await import("../src/cli.js");
    assert.equal(typeof cli.resolveListenOptions, "function");
    assert.deepEqual(cli.resolveListenOptions({}), { host: "127.0.0.1", port: 8787 });
    assert.deepEqual(cli.resolveListenOptions({ NAS_BIND_HOST: "::1", NAS_PORT: "65535" }), { host: "::1", port: 65535 });
  } finally {
    process.exitCode = originalExitCode;
  }
});

test("rejects unsafe listen host and port forms without echoing values", async () => {
  const originalExitCode = process.exitCode;
  try {
    process.exitCode = 0;
    const cli = await import("../src/cli.js");
    assert.equal(typeof cli.resolveListenOptions, "function");
    for (const NAS_BIND_HOST of ["0.0.0.0", "::", "192.168.0.10", "nas.local", " 127.0.0.1", "127.0.0.1 "]) assert.throws(() => cli.resolveListenOptions({ NAS_BIND_HOST }), /NAS_LISTEN_INVALID/);
    for (const NAS_PORT of ["", "1023", "65536", "0", "-1", "+8787", "8787.5", "0x2253", "NaN", "Infinity", " 8787"]) assert.throws(() => cli.resolveListenOptions({ NAS_PORT }), /NAS_LISTEN_INVALID/);
  } finally {
    process.exitCode = originalExitCode;
  }
});
