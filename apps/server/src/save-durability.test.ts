import { readFile } from "node:fs/promises";
import path from "node:path";
import Fastify from "fastify";
import { expect, it, vi } from "vitest";
import { tempDir } from "@galgame/testkit";
import { createApp } from "./bootstrap.ts";
import { registerRoutes } from "./routes.ts";

const fault = vi.hoisted(() => ({ directory: "", phase: "" as "" | "temporary" | "directory" }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...fs,
    writeFile: async (...args: Parameters<typeof fs.writeFile>) => {
      const [file, , options] = args;
      if (fault.phase === "temporary" && typeof file === "string" && path.dirname(file) === fault.directory) {
        expect(options).toMatchObject({ flush: true });
        fault.phase = "";
        throw new Error("simulated temporary file sync failure");
      }
      return fs.writeFile(...args);
    },
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      if (args[0] === fault.directory && fault.phase === "directory") {
        fault.phase = "";
        vi.spyOn(handle, "sync").mockRejectedValueOnce(new Error("simulated directory sync failure"));
      }
      return handle;
    },
  };
});

it("区分替换前和替换后故障，只冻结结果待核对的房间", async () => {
  const dataDir = tempDir("galgame-save-sync-");
  const deps = await createApp({
    port: 0, host: "127.0.0.1", dataDir, contentDir: "content", adminToken: "test-admin",
    trustUserHeader: true,
    llm: { baseUrl: "", model: "mock", apiKey: "", timeoutMs: 1000 },
    audit: { baseUrl: "", model: "", apiKey: "", timeoutMs: 1000 },
  });
  const app = Fastify();
  registerRoutes(app, deps);
  try {
    const userId = "u_sync";
    const otherUser = "u_other";
    const { roomId, actorId } = await deps.createRoom("solo", userId);
    const healthy = await deps.createRoom("solo", otherUser);
    const headers = { "x-user-id": userId };
    const url = `/api/v1/rooms/${roomId}/turns`;
    const clientTurnId = "test_sync";
    const submit = () => app.inject({
      method: "POST", url, headers,
      payload: { clientTurnId, actorId, input: "我去图书馆看看" },
    });
    fault.directory = path.join(dataDir, "rooms");
    const file = path.join(fault.directory, `${roomId}.jsonl`);
    const original = await readFile(file, "utf8");

    fault.phase = "temporary";
    const failedWrite = await submit();
    expect(failedWrite.body).toContain('"code":"E_STORE_FAULT"');
    expect(failedWrite.body).toContain('"retryable":true');
    expect(await readFile(file, "utf8")).toBe(original);
    expect(deps.ledger?.get({ userId, roomId, clientTurnId })?.state).toBe("failed");

    fault.phase = "directory";
    const unknown = await submit();
    expect(unknown.body).toContain('"code":"E_STORE_FAULT"');
    expect(unknown.body).toContain('"retryable":false');
    expect(unknown.body).not.toContain("turn.commit");
    expect(deps.ledger?.get({ userId, roomId, clientTurnId })?.state).toBe("unconfirmed");
    expect((await readFile(file, "utf8")).startsWith(original)).toBe(true);
    expect(await readFile(file, "utf8")).not.toBe(original);
    expect((await submit()).statusCode).toBe(503);

    const ok = await app.inject({
      method: "POST", url: `/api/v1/rooms/${healthy.roomId}/turns`, headers: { "x-user-id": otherUser },
      payload: { clientTurnId, actorId: healthy.actorId, input: "我去图书馆看看" },
    });
    expect(ok.body).toContain("turn.commit");
  } finally {
    fault.directory = "";
    fault.phase = "";
    await deps.ledger?.flush();
    await app.close();
  }
});
