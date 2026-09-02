// Test setup for pi-zalo-plus.
//
// Provides shared test utilities and mocks for pi extension API types.

import { vi } from "vitest";

// Mock the pi coding agent module for tests that import it.
vi.mock("@earendil-works/pi-coding-agent", () => ({
  AgentSession: class MockAgentSession {
    static prototype = {
      bindExtensions: vi.fn(),
    };
  },
  SessionManager: class MockSessionManager {
    static list = vi.fn().mockResolvedValue([]);
    static create = vi.fn();
    static open = vi.fn();
    getEntries = vi.fn().mockReturnValue([]);
    getSessionFile = vi.fn();
    getSessionName = vi.fn();
    getCwd = vi.fn().mockReturnValue("/tmp");
    setSessionName = vi.fn();
  },
}));
