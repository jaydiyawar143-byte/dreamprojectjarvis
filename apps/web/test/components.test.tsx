import { describe, it, expect } from "vitest";
import React from "react";
import { render, screen } from "@testing-library/react";
import { MessageList } from "../src/components/message-list";
import { MessageInput } from "../src/components/message-input";
import type { ConversationMessage } from "../src/lib/api";

const mockMessages: ConversationMessage[] = [
  { id: "1", role: "user", content: "Hello JARVIS", createdAt: "2026-08-17T10:00:00Z" },
  { id: "2", role: "assistant", content: "Hello! How can I help you?", createdAt: "2026-08-17T10:00:01Z" },
];

describe("MessageList", () => {
  it("1. Renders user message", () => {
    render(<MessageList messages={mockMessages} loading={false} sending={false} />);
    expect(screen.getByText("Hello JARVIS")).toBeInTheDocument();
  });

  it("2. Renders assistant message", () => {
    render(<MessageList messages={mockMessages} loading={false} sending={false} />);
    expect(screen.getByText("Hello! How can I help you?")).toBeInTheDocument();
  });

  it("3. Shows loading state", () => {
    render(<MessageList messages={[]} loading={true} sending={false} />);
    expect(screen.getByText("Loading messages...")).toBeInTheDocument();
  });

  it("4. Shows typing indicator when sending", () => {
    const { container } = render(<MessageList messages={mockMessages} loading={false} sending={true} />);
    const bouncingDots = container.querySelectorAll(".animate-bounce");
    expect(bouncingDots.length).toBe(3);
  });

  it("5. User message has correct styling", () => {
    render(<MessageList messages={[mockMessages[0]]} loading={false} sending={false} />);
    const userMsg = screen.getByText("Hello JARVIS").closest("div");
    expect(userMsg?.className).toContain("bg-indigo-600");
  });

  it("6. Assistant message has correct styling", () => {
    render(<MessageList messages={[mockMessages[1]]} loading={false} sending={false} />);
    const asstMsg = screen.getByText("Hello! How can I help you?").closest("div");
    expect(asstMsg?.className).toContain("bg-gray-800");
  });
});

describe("MessageInput", () => {
  it("7. Renders input field", () => {
    render(<MessageInput disabled={false} conversationId={null} />);
    expect(screen.getByPlaceholderText("Message JARVIS...")).toBeInTheDocument();
  });

  it("8. Disabled state disables textarea", () => {
    render(<MessageInput disabled={true} conversationId={null} />);
    expect(screen.getByPlaceholderText("Message JARVIS...")).toBeDisabled();
  });

  it("9. Shows hint text", () => {
    render(<MessageInput disabled={false} conversationId={null} />);
    expect(screen.getByText("Enter to send, Shift+Enter for newline")).toBeInTheDocument();
  });

  it("10. Send button present", () => {
    render(<MessageInput disabled={false} conversationId={null} />);
    const btn = screen.getByRole("button");
    expect(btn).toBeInTheDocument();
  });
});
