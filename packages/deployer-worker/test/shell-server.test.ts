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

const findUnique = vi.fn();
vi.mock("../src/db.js", () => ({
  prisma: { agent: { findUnique: (...a: unknown[]) => findUnique(...a) } },
}));

const getContainer = vi.fn();
const execMock = vi.fn();
vi.mock("../src/docker.js", () => ({
  docker: { getContainer: (...a: unknown[]) => getContainer(...a) },
}));

const { mintToken } = await import("../src/ws-auth.js");
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
  execMock.mockReset();
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

/** A real Duplex the exec mock returns — echoes writes back as 'data', same
 * shape as a Tty exec stream, so a round trip through it proves both the
 * stdin write path and the stdout->WS forward path in one assertion. */
function fakeExecStream(): PassThrough {
  return new PassThrough();
}

describe("shell WS session", () => {
  it("closes 4401 when the token is invalid", async () => {
    // #given a valid-looking agent but a garbage token
    findUnique.mockResolvedValue({ userId: "user_1", status: "running", containerId: "c1" });
    const ws = connect("/v1/agents/agent_abc/shell?token=garbage");

    // #then the upgrade is rejected with the auth close code, no exec attempted
    const code = await waitClose(ws);
    expect(code).toBe(4401);
    expect(getContainer).not.toHaveBeenCalled();
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
    findUnique.mockResolvedValue({ userId: "user_2", status: "running", containerId: "c1" });
    const token = mintToken("agent_abc", "user_1", 60);
    const ws = connect(`/v1/agents/agent_abc/shell?token=${token}`);

    const code = await waitClose(ws);
    expect(code).toBe(4403);
    expect(getContainer).not.toHaveBeenCalled();
  });

  it("closes 4409 when the agent isn't running", async () => {
    // #given an owned agent that's stopped (no live container to exec into)
    findUnique.mockResolvedValue({ userId: "user_1", status: "stopped", containerId: null });
    const token = mintToken("agent_abc", "user_1", 60);
    const ws = connect(`/v1/agents/agent_abc/shell?token=${token}`);

    const code = await waitClose(ws);
    expect(code).toBe(4409);
    expect(getContainer).not.toHaveBeenCalled();
  });

  it("execs into the owner's container as HERMES_UID, cwd /opt/data, bash-or-sh", async () => {
    // #given a running, owned agent
    findUnique.mockResolvedValue({ userId: "user_1", status: "running", containerId: "c1" });
    const stream = fakeExecStream();
    execMock.mockResolvedValue({
      start: vi.fn().mockResolvedValue(stream),
      resize: vi.fn().mockResolvedValue(undefined),
    });
    getContainer.mockReturnValue({ exec: execMock });
    const token = mintToken("agent_abc", "user_1", 60);
    const ws = connect(`/v1/agents/agent_abc/shell?token=${token}`);
    await waitOpen(ws);

    // #then the exec is scoped exactly like the gateway's own process: same
    // uid:gid, on the read-only-rootfs's one writable path
    await vi.waitFor(() => expect(execMock).toHaveBeenCalled());
    expect(getContainer).toHaveBeenCalledWith("c1");
    expect(execMock).toHaveBeenCalledWith(
      expect.objectContaining({
        User: "10000:10000",
        WorkingDir: "/opt/data",
        Tty: true,
        AttachStdin: true,
      }),
    );
    ws.close();
  });

  it("starts bash/sh with -i so job control is on (regression: without it, Ctrl-C kills the whole shell instead of just the foreground command, and any /dev/tty prompt like ssh's host-key confirmation hangs forever)", async () => {
    // #given a running, owned agent
    findUnique.mockResolvedValue({ userId: "user_1", status: "running", containerId: "c1" });
    const stream = fakeExecStream();
    execMock.mockResolvedValue({
      start: vi.fn().mockResolvedValue(stream),
      resize: vi.fn().mockResolvedValue(undefined),
    });
    getContainer.mockReturnValue({ exec: execMock });
    const token = mintToken("agent_abc", "user_1", 60);
    const ws = connect(`/v1/agents/agent_abc/shell?token=${token}`);
    await waitOpen(ws);

    await vi.waitFor(() => expect(execMock).toHaveBeenCalled());
    const call = execMock.mock.calls[0]![0];
    expect(call.Cmd).toEqual(["/bin/sh", "-c", "exec bash -i 2>/dev/null || exec sh -i"]);
    expect(call.Env).toContain("TERM=xterm-256color");
    ws.close();
  });

  it("forwards exec stdout bytes to the client as binary frames", async () => {
    // #given a connected shell session
    findUnique.mockResolvedValue({ userId: "user_1", status: "running", containerId: "c1" });
    const stream = fakeExecStream();
    execMock.mockResolvedValue({
      start: vi.fn().mockResolvedValue(stream),
      resize: vi.fn().mockResolvedValue(undefined),
    });
    getContainer.mockReturnValue({ exec: execMock });
    const token = mintToken("agent_abc", "user_1", 60);
    const ws = connect(`/v1/agents/agent_abc/shell?token=${token}`);
    await waitOpen(ws);
    await vi.waitFor(() => expect(execMock).toHaveBeenCalled());

    // #when the exec stream emits PTY output
    const got = new Promise<Buffer>((resolve) => ws.once("message", (d) => resolve(d as Buffer)));
    stream.write("hello$ ");

    // #then the client receives it verbatim
    expect((await got).toString("utf8")).toBe("hello$ ");
    ws.close();
  });

  it("writes client keystrokes to the exec stdin", async () => {
    // #given a connected shell session
    findUnique.mockResolvedValue({ userId: "user_1", status: "running", containerId: "c1" });
    const stream = fakeExecStream();
    execMock.mockResolvedValue({
      start: vi.fn().mockResolvedValue(stream),
      resize: vi.fn().mockResolvedValue(undefined),
    });
    getContainer.mockReturnValue({ exec: execMock });
    const token = mintToken("agent_abc", "user_1", 60);
    const ws = connect(`/v1/agents/agent_abc/shell?token=${token}`);
    await waitOpen(ws);
    await vi.waitFor(() => expect(execMock).toHaveBeenCalled());

    // #when the client sends a keystroke frame
    const echoed = new Promise<Buffer>((resolve) => ws.once("message", (d) => resolve(d as Buffer)));
    ws.send(JSON.stringify({ type: "data", data: "ls\n" }));

    // #then it reaches the exec stdin (the fake stream echoes writes back out
    // as 'data', proving the write happened)
    expect((await echoed).toString("utf8")).toBe("ls\n");
    ws.close();
  });

  it("resizes the exec pty on a resize frame", async () => {
    // #given a connected shell session
    findUnique.mockResolvedValue({ userId: "user_1", status: "running", containerId: "c1" });
    const stream = fakeExecStream();
    const resize = vi.fn().mockResolvedValue(undefined);
    execMock.mockResolvedValue({ start: vi.fn().mockResolvedValue(stream), resize });
    getContainer.mockReturnValue({ exec: execMock });
    const token = mintToken("agent_abc", "user_1", 60);
    const ws = connect(`/v1/agents/agent_abc/shell?token=${token}`);
    await waitOpen(ws);
    await vi.waitFor(() => expect(execMock).toHaveBeenCalled());

    // #when the client reports its terminal size
    ws.send(JSON.stringify({ type: "resize", cols: 120, rows: 40 }));

    // #then the exec pty is resized to match
    await vi.waitFor(() => expect(resize).toHaveBeenCalledWith({ h: 40, w: 120 }));
    ws.close();
  });

  it("ignores malformed client frames instead of crashing the session", async () => {
    // #given a connected shell session
    findUnique.mockResolvedValue({ userId: "user_1", status: "running", containerId: "c1" });
    const stream = fakeExecStream();
    const resize = vi.fn().mockResolvedValue(undefined);
    execMock.mockResolvedValue({ start: vi.fn().mockResolvedValue(stream), resize });
    getContainer.mockReturnValue({ exec: execMock });
    const token = mintToken("agent_abc", "user_1", 60);
    const ws = connect(`/v1/agents/agent_abc/shell?token=${token}`);
    await waitOpen(ws);
    await vi.waitFor(() => expect(execMock).toHaveBeenCalled());

    // #when the client sends garbage text
    ws.send("not json");
    ws.send(JSON.stringify({ type: "unknown" }));

    // #then the socket stays open and a valid frame right after still works
    const echoed = new Promise<Buffer>((resolve) => ws.once("message", (d) => resolve(d as Buffer)));
    ws.send(JSON.stringify({ type: "data", data: "ok\n" }));
    expect((await echoed).toString("utf8")).toBe("ok\n");
    ws.close();
  });

  it("closes 1000 when the exec stream ends", async () => {
    // #given a connected shell session
    findUnique.mockResolvedValue({ userId: "user_1", status: "running", containerId: "c1" });
    const stream = fakeExecStream();
    execMock.mockResolvedValue({
      start: vi.fn().mockResolvedValue(stream),
      resize: vi.fn().mockResolvedValue(undefined),
    });
    getContainer.mockReturnValue({ exec: execMock });
    const token = mintToken("agent_abc", "user_1", 60);
    const ws = connect(`/v1/agents/agent_abc/shell?token=${token}`);
    await waitOpen(ws);
    await vi.waitFor(() => expect(execMock).toHaveBeenCalled());

    // #when the shell process exits (exec stream closes)
    const codeP = waitClose(ws);
    stream.end();

    // #then the client socket closes cleanly
    expect(await codeP).toBe(1000);
  });
});
