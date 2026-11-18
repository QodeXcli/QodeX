/**
 * Minimal declarations for the Frida Java and Objective-C bridges.
 *
 * `@types/frida-gum` does not declare `Java` / `ObjC` (they live in the
 * separate frida-java-bridge and frida-objc-bridge runtimes, which ship no
 * DefinitelyTyped package). Only the members the REA agents actually use
 * are declared here; the rest of each bridge is intentionally untyped.
 */
type JavaMethod = ((...args: any[]) => any) & {
  implementation: ((...args: any[]) => any) | null;
};

declare const Java: {
  /** True when the target process has a Java runtime loaded. */
  readonly available: boolean;
  /** Run `fn` on the Java thread (required before touching Java APIs). */
  perform(fn: () => void): void;
  /** Look up a Java class by name. Throws when the class is not loaded. */
  use(className: string): { [method: string]: JavaMethod };
};

declare const ObjC: {
  /** True when the target process has an Objective-C runtime loaded. */
  readonly available: boolean;
};
