import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { WebSocket as WsClient } from "ws";
import { PassThrough } from "node:stream";
import type { AddressInfo } from "node:net";

process.env.DEPLOYER_WS_SECRET = "test-secret-shell-server-00000000000000";
// Different literal port than ws-server.test.ts (57321) — both bind a real
// TCP port and vitest can run test files concurrently in separate workers,
// so a shared port number would collide.
process.env.DEPLOYER_WS_PORT = "57322";
process.env.HERMES_IMAGE ??= "ghcr.io/test/hermes:latest";
process.env.TOOLBOX_IMAGE ??= "test/toolbox:latest";

const findUnique = vi.fn();
vi.mock("../src/db.js", () => ({
  prisma: { agent: { findUnique: (...a: unknown[]) => findUnique(...a) } },
}));

const getContainer = vi.fn();
const runToolboxContainerMock = vi.fn();
const stopAndRemoveMock = vi.fn();
vi.mock("../src/docker.js", () => ({
  docker: { getContainer: (...a: unknown[]) => getContainer(...a) },
  runToolboxContainer: (...a: unknown[]) => runToolboxContainerMock(...a),
  stopAndRemove: (...a: unknown[]) => stopAndRemoveMock(...a),
}));

const { mintToken } = await import("../src/ws-auth.js");
const { paths } = await import("../src/config.js");
const { startWsServer } = await import("../src/ws.js");

let baseUrl: string;
let close: () => void;

beforeAll(async () => {
  const handle = await startWsServer();
  if (!handle) throw new Error("server did not start");
  const addr = handle.address() as AddressInfo;
  baseUrl = `ws://127.0.0.1:${addr.port}`;
  close = () => handle.close();
});

afterAll(() => close?.());
beforeEach(() => {
  findUnique.mockReset();
  getContainer.mockReset();
  runToolboxContainerMock.mockReset();
  stopAndRemoveMock.mockReset().mockResolvedValue(undefined);
});

function connect(path: string): WsClient {
  return new WsClient(`${baseUrl}${path}`);
}

function waitClose(ws: WsClient): Promise<number> {
  return new Promise((resolve) => ws.once("close", (code) => resolve(code)));
}

function waitOpen(ws: WsClient): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
}

/** A real Duplex the attach mock returns — echoes writes back as 'data', same
 * shape as a Tty container-attach stream, so a round trip through it proves
 * both the stdin write path and the stdout->WS forward path in one
 * assertion. */
function fakeAttachStream(): PassThrough {
  return new PassThrough();
}

/** Wires runToolboxContainer + getContainer for the happy path: resolves a
 * fake toolbox container id, and getContainer(id) returns an object whose
 * attach()/resize() are the given mocks. */
function wireToolbox(stream: PassThrough, resize = vi.fn().mockResolvedValue(undefined)) {
  runToolboxContainerMock.mockResolvedValue("toolbox-c1");
  const attach = vi.fn().mockResolvedValue(stream);
  getContainer.mockReturnValue({ attach, resize });
  return { attach, resize };
}

describe("shell WS session", () => {
  it("closes 4401 when the token is invalid", async () => {
    // #given a valid-looking agent but a garbage token
    findUnique.mockResolvedValue({ userId: "user_1", status: "running" });
    const ws = connect("/v1/agents/agent_abc/shell?token=garbage");

    // #then the upgrade is rejected with the auth close code, no container spun up
    const code = await waitClose(ws);
    expect(code).toBe(4401);
    expect(runToolboxContainerMock).not.toHaveBeenCalled();
  });

  it("closes 4404 when the agent does not exist", async () => {
    // #given a valid token but no row
    findUnique.mockResolvedValue(null);
    const token = mintToken("agent_abc", "user_1", 60);
    const ws = connect(`/v1/agents/agent_abc/shell?token=${token}`);

    const code = await waitClose(ws);
    expect(code).toBe(4404);
  });

  it("closes 4403 when the token user does not own the agent", async () => {
    // #given the row is owned by user_2 but the token is for user_1
    findUnique.mockResolvedValue({ userId: "user_2", status: "running" });
    const token = mintToken("agent_abc", "user_1", 60);
    const ws = connect(`/v1/agents/agent_abc/shell?token=${token}`);

    const code = await waitClose(ws);
    expect(code).toBe(4403);
    expect(runToolboxContainerMock).not.toHaveBeenCalled();
  });

  it("closes 4409 when the agent isn't running", async () => {
    // #given an owned agent that's stopped
    findUnique.mockResolvedValue({ userId: "user_1", status: "stopped" });
    const token = mintToken("agent_abc", "user_1", 60);
    const ws = connect(`/v1/agents/agent_abc/shell?token=${token}`);

    const code = await waitClose(ws);
    expect(code).toBe(4409);
    expect(runToolboxContainerMock).not.toHaveBeenCalled();
  });

  it("spins up an ephemeral toolbox container bind-mounted at the agent's own data dir", async () => {
    // #given a running, owned agent
    findUnique.mockResolvedValue({ userId: "user_1", status: "running" });
    wireToolbox(fakeAttachStream());
    const token = mintToken("agent_abc", "user_1", 60);
    const ws = connect(`/v1/agents/agent_abc/shell?token=${token}`);
    await waitOpen(ws);

    // #then the toolbox is scoped to exactly this agent's own data
    await vi.waitFor(() => expect(runToolboxContainerMock).toHaveBeenCalled());
    expect(runToolboxContainerMock).toHaveBeenCalledWith({
      agentId: "agent_abc",
      dataDir: paths.agentData("agent_abc"),
    });
    expect(getContainer).toHaveBeenCalledWith("toolbox-c1");
    ws.close();
  });

  it("closes 4501 when TOOLBOX_IMAGE isn't configured", async () => {
    // #given a fresh module graph with TOOLBOX_IMAGE unset — config reads env
    // once at import, so this needs isolation from the file's module-level
    // TOOLBOX_IMAGE default set above.
    vi.resetModules();
    const savedToolbox = process.env.TOOLBOX_IMAGE;
    delete process.env.TOOLBOX_IMAGE;
    process.env.DEPLOYER_WS_PORT = "57323";
    try {
      vi.doMock("../src/db.js", () => ({
        prisma: { agent: { findUnique: (...a: unknown[]) => findUnique(...a) } },
      }));
      vi.doMock("../src/docker.js", () => ({
        docker: { getContainer: (...a: unknown[]) => getContainer(...a) },
        runToolboxContainer: (...a: unknown[]) => runToolboxContainerMock(...a),
        stopAndRemove: (...a: unknown[]) => stopAndRemoveMock(...a),
      }));
      const { mintToken: mintTokenFresh } = await import("../src/ws-auth.js");
      const { startWsServer: startFresh } = await import("../src/ws.js");
      const handle = await startFresh();
      if (!handle) throw new Error("server did not start");
      const addr = handle.address() as AddressInfo;

      findUnique.mockResolvedValue({ userId: "user_1", status: "running" });
      const token = mintTokenFresh("agent_abc", "user_1", 60);
      const ws = new WsClient(`ws://127.0.0.1:${addr.port}/v1/agents/agent_abc/shell?token=${token}`);

      const code = await waitClose(ws);
      expect(code).toBe(4501);
      expect(runToolboxContainerMock).not.toHaveBeenCalled();
      handle.close();
    } finally {
      if (savedToolbox === undefined) delete process.env.TOOLBOX_IMAGE;
      else process.env.TOOLBOX_IMAGE = savedToolbox;
      process.env.DEPLOYER_WS_PORT = "57322";
    }
  });

  it("forwards container output bytes to the client as binary frames", async () => {
    // #given a connected shell session
    findUnique.mockResolvedValue({ userId: "user_1", status: "running" });
    const stream = fakeAttachStream();
    wireToolbox(stream);
    const token = mintToken("agent_abc", "user_1", 60);
    const ws = connect(`/v1/agents/agent_abc/shell?token=${token}`);
    await waitOpen(ws);
    await vi.waitFor(() => expect(runToolboxContainerMock).toHaveBeenCalled());

    // #when the attach stream emits PTY output
    const got = new Promise<Buffer>((resolve) => ws.once("message", (d) => resolve(d as Buffer)));
    stream.write("hello$ ");

    // #then the client receives it verbatim
    expect((await got).toString("utf8")).toBe("hello$ ");
    ws.close();
  });

  it("writes client keystrokes to the container stdin", async () => {
    // #given a connected shell session
    findUnique.mockResolvedValue({ userId: "user_1", status: "running" });
    const stream = fakeAttachStream();
    wireToolbox(stream);
    const token = mintToken("agent_abc", "user_1", 60);
    const ws = connect(`/v1/agents/agent_abc/shell?token=${token}`);
    await waitOpen(ws);
    await vi.waitFor(() => expect(runToolboxContainerMock).toHaveBeenCalled());

    // #when the client sends a keystroke frame
    const echoed = new Promise<Buffer>((resolve) => ws.once("message", (d) => resolve(d as Buffer)));
    ws.send(JSON.stringify({ type: "data", data: "ls\n" }));

    // #then it reaches the container's stdin (the fake stream echoes writes
    // back out as 'data', proving the write happened)
    expect((await echoed).toString("utf8")).toBe("ls\n");
    ws.close();
  });

  it("resizes the container's pty on a resize frame", async () => {
    // #given a connected shell session
    findUnique.mockResolvedValue({ userId: "user_1", status: "running" });
    const resize = vi.fn().mockResolvedValue(undefined);
    wireToolbox(fakeAttachStream(), resize);
    const token = mintToken("agent_abc", "user_1", 60);
    const ws = connect(`/v1/agents/agent_abc/shell?token=${token}`);
    await waitOpen(ws);
    await vi.waitFor(() => expect(runToolboxContainerMock).toHaveBeenCalled());

    // #when the client reports its terminal size
    ws.send(JSON.stringify({ type: "resize", cols: 120, rows: 40 }));

    // #then the container's pty is resized to match
    await vi.waitFor(() => expect(resize).toHaveBeenCalledWith({ h: 40, w: 120 }));
    ws.close();
  });

  it("ignores malformed client frames instead of crashing the session", async () => {
    // #given a connected shell session
    findUnique.mockResolvedValue({ userId: "user_1", status: "running" });
    wireToolbox(fakeAttachStream());
    const token = mintToken("agent_abc", "user_1", 60);
    const ws = connect(`/v1/agents/agent_abc/shell?token=${token}`);
    await waitOpen(ws);
    await vi.waitFor(() => expect(runToolboxContainerMock).toHaveBeenCalled());

    // #when the client sends garbage text
    ws.send("not json");
    ws.send(JSON.stringify({ type: "unknown" }));

    // #then the socket stays open and a valid frame right after still works
    const echoed = new Promise<Buffer>((resolve) => ws.once("message", (d) => resolve(d as Buffer)));
    ws.send(JSON.stringify({ type: "data", data: "ok\n" }));
    expect((await echoed).toString("utf8")).toBe("ok\n");
    ws.close();
  });

  it("closes 1000 and tears down the toolbox container when the attach stream ends", async () => {
    // #given a connected shell session
    findUnique.mockResolvedValue({ userId: "user_1", status: "running" });
    const stream = fakeAttachStream();
    wireToolbox(stream);
    const token = mintToken("agent_abc", "user_1", 60);
    const ws = connect(`/v1/agents/agent_abc/shell?token=${token}`);
    await waitOpen(ws);
    await vi.waitFor(() => expect(runToolboxContainerMock).toHaveBeenCalled());

    // #when the shell process exits (attach stream closes)
    const codeP = waitClose(ws);
    stream.end();

    // #then the client socket closes cleanly and the ephemeral container is
    // torn down — it exists for exactly this one session
    expect(await codeP).toBe(1000);
    await vi.waitFor(() => expect(stopAndRemoveMock).toHaveBeenCalledWith("toolbox-c1"));
  });

  it("tears down the toolbox container when the client closes the WS first", async () => {
    // #given a connected shell session
    findUnique.mockResolvedValue({ userId: "user_1", status: "running" });
    wireToolbox(fakeAttachStream());
    const token = mintToken("agent_abc", "user_1", 60);
    const ws = connect(`/v1/agents/agent_abc/shell?token=${token}`);
    await waitOpen(ws);
    await vi.waitFor(() => expect(runToolboxContainerMock).toHaveBeenCalled());

    // #when the client (browser tab closed, e.g.) hangs up first
    ws.close();

    // #then the ephemeral toolbox container is still cleaned up server-side
    await vi.waitFor(() => expect(stopAndRemoveMock).toHaveBeenCalledWith("toolbox-c1"));
  });
});
