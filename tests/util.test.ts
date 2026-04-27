import { describe, expect, test } from "bun:test";
import { validateName, composeProject, NAME_PATTERN } from "../src/util.ts";

describe("validateName", () => {
  test("accepts simple lowercase names", () => {
    expect(() => validateName("foo")).not.toThrow();
    expect(() => validateName("foo-bar")).not.toThrow();
    expect(() => validateName("amphtt-864-modular")).not.toThrow();
    expect(() => validateName("a1")).not.toThrow();
  });

  test("rejects uppercase", () => {
    expect(() => validateName("Foo")).toThrow();
    expect(() => validateName("AMPHTT-864")).toThrow();
  });

  test("rejects leading hyphen", () => {
    expect(() => validateName("-foo")).toThrow();
  });

  test("rejects spaces and special characters", () => {
    expect(() => validateName("foo bar")).toThrow();
    expect(() => validateName("foo/bar")).toThrow();
    expect(() => validateName("foo_bar")).toThrow();
  });

  test("rejects empty string", () => {
    expect(() => validateName("")).toThrow();
  });
});

describe("composeProject", () => {
  test("prefixes with cwt-", () => {
    expect(composeProject("foo")).toBe("cwt-foo");
    expect(composeProject("amphtt-864")).toBe("cwt-amphtt-864");
  });
});

describe("NAME_PATTERN", () => {
  test("matches valid names", () => {
    expect(NAME_PATTERN.test("foo")).toBe(true);
    expect(NAME_PATTERN.test("amphtt-864-foo")).toBe(true);
  });

  test("does not match invalid", () => {
    expect(NAME_PATTERN.test("Foo")).toBe(false);
    expect(NAME_PATTERN.test("-foo")).toBe(false);
  });
});
