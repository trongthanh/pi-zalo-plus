// Test setup for pi-zalo-plus.
//
// Provides shared test utilities and mocks for pi extension API types.

import { vi } from "vitest";

// Mock the pi coding agent module for tests that import it.
vi.mock("@earendil-works/pi-coding-agent", () => {
  const mockBindExtensions = vi.fn();
  const MockAgentSession = vi.fn() as unknown as typeof import("@earendil-works/pi-coding-agent").AgentSession;
  // prototype must be set after creation — `static prototype = {}` is illegal on classes
  (MockAgentSession as unknown as Record<string, unknown>).prototype = { bindExtensions: mockBindExtensions };

  const mockList = vi.fn().mockResolvedValue([]);
  const mockCreate = vi.fn();
  const mockOpen = vi.fn();
  const MockSessionManager = vi.fn() as unknown as typeof import("@earendil-works/pi-coding-agent").SessionManager;
  MockSessionManager.list = mockList;
  MockSessionManager.create = mockCreate;
  MockSessionManager.open = mockOpen;
  MockSessionManager.prototype.getEntries = vi.fn().mockReturnValue([]);
  MockSessionManager.prototype.getSessionFile = vi.fn();
  MockSessionManager.prototype.getSessionName = vi.fn();
  MockSessionManager.prototype.getCwd = vi.fn().mockReturnValue("/tmp");
  (MockSessionManager.prototype as unknown as Record<string, unknown>).setSessionName = vi.fn();

  return {
    AgentSession: MockAgentSession,
    SessionManager: MockSessionManager,
  };
});
