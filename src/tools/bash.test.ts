import { describe, it, expect } from "vitest";
import { isDangerousCommand, executeBash } from "./bash.js";

describe("isDangerousCommand", () => {
  it("blocks rm -rf", () => {
    expect(isDangerousCommand("rm -rf /")).toBe(true);
    expect(isDangerousCommand("rm -rf /home/user")).toBe(true);
    expect(isDangerousCommand("rm -fr /tmp")).toBe(true);
  });

  it("allows safe rm", () => {
    expect(isDangerousCommand("rm file.txt")).toBe(false);
    expect(isDangerousCommand("rm -r ./build")).toBe(false);
  });

  it("blocks mkfs", () => {
    expect(isDangerousCommand("mkfs.ext4 /dev/sda1")).toBe(true);
  });

  it("blocks fork bomb", () => {
    expect(isDangerousCommand(":(){ :|:& };:")).toBe(true);
  });

  it("blocks shutdown/reboot", () => {
    expect(isDangerousCommand("shutdown now")).toBe(true);
    expect(isDangerousCommand("reboot")).toBe(true);
  });

  it("allows safe commands", () => {
    expect(isDangerousCommand("ls -la")).toBe(false);
    expect(isDangerousCommand("echo hello")).toBe(false);
    expect(isDangerousCommand("cat file.txt")).toBe(false);
    expect(isDangerousCommand("git status")).toBe(false);
  });
});

describe("executeBash", () => {
  it("executes a simple command", async () => {
    const result = await executeBash("echo hello");
    expect(result.error).toBe(false);
    expect(result.output.trim()).toBe("hello");
  });

  it("captures stderr on failure", async () => {
    const result = await executeBash("ls /nonexistent_directory_xyz");
    expect(result.error).toBe(true);
    expect(result.output).toContain("nonexistent_directory_xyz");
  });

  it("blocks dangerous commands", async () => {
    const result = await executeBash("rm -rf /");
    expect(result.error).toBe(true);
    expect(result.output).toContain("blocked");
  });
});
