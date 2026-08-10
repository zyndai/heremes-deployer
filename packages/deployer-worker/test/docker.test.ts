import { beforeEach, expect, test, vi } from "vitest";

const getContainer = vi.fn();
const createContainerMock = vi.fn();
const listNetworksMock = vi.fn();
const createNetworkMock = vi.fn();
vi.mock("dockerode", () => ({
  default: vi.fn().mockImplementation(() => ({
    getContainer,
    createContainer: createContainerMock,
    listNetworks: listNetworksMock,
    createNetwork: createNetworkMock,
  })),
}));

vi.mock("../src/config", () => ({
  config: {
    dockerSocket: "/var/run/docker.sock",
    hermesImage: "hermes/gateway:latest",
    containerMemoryMb: 1536,
    containerCpuMillis: 1000,
    containerTmpfsMb: 512,
    bootHealthTimeoutMs: 1000,
    bootHealthIntervalMs: 10,
  },
  API_PORT: 8642,
  DASHBOARD_PORT: 9119,
  // Pre-existing gap: docker.ts imports these two named exports too (Tmpfs
  // mount options), and vitest throws "No export defined on mock" the moment
  // runContainer's Tmpfs template literal reads an export this mock never
  // declared — unrelated to network isolation, just adjacent in the same mock.
  HERMES_UID: 10000,
  HERMES_GID: 10000,
}));

const { tailLogs, stopAndRemove, inspectExitCode, inspectTerminalState } = await import(
  "../src/docker"
);

beforeEach(() => {
  getContainer.mockReset();
  // Re-armed every test: the file's later `afterEach(() => vi.restoreAllMocks())`
  // (added for the docker.createContainer spy) also clears plain vi.fn()
  // implementations, not just spies — so a one-time module-load default here
  // would silently go missing starting with whichever test runs after that
  // afterEach first fires. Default: network already exists, so
  // ensureAgentNetwork() is a one-call no-op for tests that don't care about it.
  listNetworksMock.mockReset().mockResolvedValue([{ Name: "hermes-agents" }]);
  createNetworkMock.mockReset();
});

// Build one dockerode multiplexed log frame: 8-byte header + payload.
// Header = [streamType, 0,0,0, payloadLen as uint32 BE].
function frame(streamType: number, payload: string): Buffer {
  const body = Buffer.from(payload, "utf8");
  const header = Buffer.alloc(8);
  header[0] = streamType; // 1=stdout, 2=stderr
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}

test("tailLogs strips 8-byte frame headers and concatenates payloads in order", async () => {
  const multiplexed = Buffer.concat([
    frame(1, "hello\n"),
    frame(2, "world\n"),
  ]);
  const logs = vi.fn().mockResolvedValue(multiplexed);
  getContainer.mockReturnValue({ logs });

  const out = await tailLogs("cid", 200);

  expect(out).toBe("hello\nworld\n");
  // The 22021 gotcha: not one NUL header byte survives into the stored text.
  expect(out.includes(" ")).toBe(false);
  expect(logs).toHaveBeenCalledWith({
    stdout: true,
    stderr: true,
    tail: 200,
    timestamps: false,
  });
});

test("tailLogs returns '' when the daemon throws", async () => {
  getContainer.mockReturnValue({
    logs: vi.fn().mockRejectedValue(new Error("no such container")),
  });
  expect(await tailLogs("cid")).toBe("");
});

test("stopAndRemove swallows already-stopped and already-gone errors", async () => {
  const stop = vi.fn().mockRejectedValue(new Error("already stopped"));
  const remove = vi.fn().mockRejectedValue(new Error("already gone"));
  getContainer.mockReturnValue({ stop, remove });
  await expect(stopAndRemove("cid")).resolves.toBeUndefined();
  expect(stop).toHaveBeenCalledWith({ t: 5 });
  expect(remove).toHaveBeenCalledWith({ force: true });
});

test("inspectExitCode returns the code, and null on inspect failure", async () => {
  getContainer.mockReturnValueOnce({
    inspect: vi.fn().mockResolvedValue({ State: { ExitCode: 137 } }),
  });
  expect(await inspectExitCode("cid")).toBe(137);

  getContainer.mockReturnValueOnce({
    inspect: vi.fn().mockRejectedValue(new Error("gone")),
  });
  expect(await inspectExitCode("cid")).toBeNull();
});

test("inspectTerminalState maps state + converts the memory limit to MB", async () => {
  getContainer.mockReturnValue({
    inspect: vi.fn().mockResolvedValue({
      State: {
        ExitCode: 0,
        OOMKilled: true,
        Error: "",
        StartedAt: "2026-06-08T00:00:00Z",
        FinishedAt: "2026-06-08T00:01:00Z",
      },
      HostConfig: { Memory: 1536 * 1024 * 1024 },
    }),
  });
  const s = await inspectTerminalState("cid");
  expect(s).toEqual({
    exitCode: 0,
    oomKilled: true,
    error: "",
    startedAt: "2026-06-08T00:00:00Z",
    finishedAt: "2026-06-08T00:01:00Z",
    memoryLimitMb: 1536,
  });
});

// --- appended: Task 23 ---
import { afterEach } from "vitest";

const { runContainer, waitForHealth, docker } = await import("../src/docker");

afterEach(() => {
  vi.restoreAllMocks();
});

test("runContainer builds the Hermes createContainer arg object (data bind, two loopback ports)", async () => {
  const start = vi.fn().mockResolvedValue(undefined);
  const createContainer = vi
    .spyOn(docker, "createContainer")
    .mockResolvedValue({ id: "deadbeefcafe0000", start } as never);

  const id = await runContainer({
    agentId: "agent-1",
    image: "hermes/gateway:latest",
    env: { API_SERVER_KEY: "secret-key", OPENROUTER_API_KEY: "sk-or-xxx", API_SERVER_ENABLED: "true" },
    apiPort: 13000,
    dashboardPort: 13001,
    dataDir: "/var/lib/hermes-deployer/agents/agent-1/data",
  });

  expect(id).toBe("deadbeefcafe0000");
  expect(start).toHaveBeenCalledOnce();

  const arg = createContainer.mock.calls[0]![0] as Record<string, unknown>;
  const hostConfig = arg.HostConfig as Record<string, unknown>;

  expect(arg.name).toBe("hermes-agent-1");
  expect(arg.Image).toBe("hermes/gateway:latest");
  expect(arg.Cmd).toEqual(["gateway", "run"]);
  expect(arg.Env).toEqual([
    "API_SERVER_KEY=secret-key",
    "OPENROUTER_API_KEY=sk-or-xxx",
    "API_SERVER_ENABLED=true",
  ]);
  expect(arg.ExposedPorts).toEqual({ "8642/tcp": {}, "9119/tcp": {} });
  expect(arg.Labels).toEqual({ "hermes.agent": "agent-1" });

  expect(hostConfig.PortBindings).toEqual({
    "8642/tcp": [{ HostIp: "127.0.0.1", HostPort: "13000" }],
    "9119/tcp": [{ HostIp: "127.0.0.1", HostPort: "13001" }],
  });
  expect(hostConfig.RestartPolicy).toEqual({ Name: "unless-stopped" });
  expect(hostConfig.Memory).toBe(1536 * 1024 * 1024);
  expect(hostConfig.NanoCpus).toBe(1000 * 1_000_000);
  expect(hostConfig.ReadonlyRootfs).toBe(true);
  // Both /tmp (gateway scratch) and /run (s6-overlay init needs it writable) —
  // a read-only rootfs without /run kills the image's init with exit 111.
  expect(hostConfig.Tmpfs).toEqual({
    "/tmp": "rw,exec,size=512m,uid=10000,gid=10000",
    "/run": "rw,exec,size=512m,uid=10000,gid=10000",
  });
  expect(hostConfig.SecurityOpt).toEqual(["no-new-privileges"]);
  // Isolated network, not Docker's default `bridge` — sibling agent
  // containers can't reach this one (icc disabled on the network itself).
  expect(hostConfig.NetworkMode).toBe("hermes-agents");
  // Writable HERMES_HOME bind — the one rw path on the read-only rootfs that the
  // gateway needs for its .env (bot tokens), config, and sessions.
  expect(hostConfig.Binds).toEqual([
    "/var/lib/hermes-deployer/agents/agent-1/data:/opt/data:rw",
  ]);
});

test("runContainer never surfaces env or argv in the error — only the daemon message", async () => {
  vi.spyOn(docker, "createContainer").mockRejectedValue(
    new Error("Error response from daemon: pull access denied"),
  );
  let caught: unknown;
  try {
    await runContainer({
      agentId: "agent-1",
      image: "hermes/gateway:latest",
      env: { OPENROUTER_API_KEY: "sk-or-SUPER-SECRET" },
      apiPort: 13000,
      dashboardPort: 13001,
      dataDir: "/var/lib/hermes-deployer/agents/agent-1/data",
    });
  } catch (e) {
    caught = e;
  }
  const msg = String((caught as Error).message);
  expect(msg).toContain("pull access denied");
  expect(msg).not.toContain("sk-or-SUPER-SECRET");
  expect(msg).not.toContain("OPENROUTER_API_KEY");
});

test("waitForHealth resolves once /health returns 200", async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce({ status: 503 })
    .mockResolvedValueOnce({ status: 200 });
  vi.stubGlobal("fetch", fetchMock);

  await waitForHealth(13000);

  expect(fetchMock).toHaveBeenCalledTimes(2);
  const url = String(fetchMock.mock.calls[0]![0]);
  expect(url).toBe("http://127.0.0.1:13000/health");
});

test("waitForHealth throws after the boot timeout when /health never returns 200", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
  );
  await expect(waitForHealth(13000)).rejects.toThrow(/health.*did not return 200/i);
});

// --- ensureAgentNetwork: module-isolated so the in-process "already ensured"
// cache from the tests above doesn't mask these — each case re-imports fresh.
test("ensureAgentNetwork creates the isolated network with ICC disabled when absent", async () => {
  vi.resetModules();
  const listNetworks = vi.fn().mockResolvedValue([]);
  const createNetwork = vi.fn().mockResolvedValue(undefined);
  vi.doMock("dockerode", () => ({
    default: vi.fn().mockImplementation(() => ({ listNetworks, createNetwork })),
  }));
  vi.doMock("../src/config", () => ({
    config: { dockerSocket: "/var/run/docker.sock" },
    API_PORT: 8642,
    DASHBOARD_PORT: 9119,
  }));

  const { ensureAgentNetwork } = await import("../src/docker");
  await ensureAgentNetwork();

  expect(createNetwork).toHaveBeenCalledWith({
    Name: "hermes-agents",
    Driver: "bridge",
    Options: { "com.docker.network.bridge.enable_icc": "false" },
  });
});

test("ensureAgentNetwork is a no-op when the network already exists", async () => {
  vi.resetModules();
  const listNetworks = vi.fn().mockResolvedValue([{ Name: "hermes-agents" }]);
  const createNetwork = vi.fn();
  vi.doMock("dockerode", () => ({
    default: vi.fn().mockImplementation(() => ({ listNetworks, createNetwork })),
  }));
  vi.doMock("../src/config", () => ({
    config: { dockerSocket: "/var/run/docker.sock" },
    API_PORT: 8642,
    DASHBOARD_PORT: 9119,
  }));

  const { ensureAgentNetwork } = await import("../src/docker");
  await ensureAgentNetwork();

  expect(createNetwork).not.toHaveBeenCalled();
});

test("ensureAgentNetwork swallows an 'already exists' race from a concurrent create", async () => {
  vi.resetModules();
  const listNetworks = vi.fn().mockResolvedValue([]);
  const createNetwork = vi.fn().mockRejectedValue(new Error("network with name hermes-agents already exists"));
  vi.doMock("dockerode", () => ({
    default: vi.fn().mockImplementation(() => ({ listNetworks, createNetwork })),
  }));
  vi.doMock("../src/config", () => ({
    config: { dockerSocket: "/var/run/docker.sock" },
    API_PORT: 8642,
    DASHBOARD_PORT: 9119,
  }));

  const { ensureAgentNetwork } = await import("../src/docker");
  await expect(ensureAgentNetwork()).resolves.toBeUndefined();
});

test("ensureAgentNetwork propagates a real daemon failure", async () => {
  vi.resetModules();
  const listNetworks = vi.fn().mockResolvedValue([]);
  const createNetwork = vi.fn().mockRejectedValue(new Error("permission denied"));
  vi.doMock("dockerode", () => ({
    default: vi.fn().mockImplementation(() => ({ listNetworks, createNetwork })),
  }));
  vi.doMock("../src/config", () => ({
    config: { dockerSocket: "/var/run/docker.sock" },
    API_PORT: 8642,
    DASHBOARD_PORT: 9119,
  }));

  const { ensureAgentNetwork } = await import("../src/docker");
  await expect(ensureAgentNetwork()).rejects.toThrow(/permission denied/);
});
