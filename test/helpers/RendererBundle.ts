import { build } from "esbuild";
import path from "node:path";
import { createRequire } from "node:module";

export async function rendererBundle(entry: string, mocks: Record<string, string>, fixture: unknown = {}, testWindow: unknown = {}): Promise<Record<string, unknown>> {
    const root = path.resolve(import.meta.dirname, "../..");
    const compiled = await build({ entryPoints: [path.join(root, entry)], bundle: true, platform: "node", format: "cjs", write: false,
        define: { "import.meta.hot": "undefined" }, alias: { "@renderer": path.join(root, "src/renderer/src"), "@shared": path.join(root, "src/shared") },
        plugins: [{ name: "fixtures", setup(builder) {
            builder.onResolve({ filter: /.*/ }, args => Object.hasOwn(mocks, args.path) ? { path: args.path, namespace: "fixture" } : null);
            builder.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents: mocks[args.path], loader: "js" }));
        } }],
    });
    const module = { exports: {} };
    new Function("require", "module", "exports", "fixture", "window", "localStorage", "fetch", compiled.outputFiles[0].text)(
        createRequire(import.meta.url), module, module.exports, fixture, testWindow, { getItem: () => null, setItem: () => {} }, (fixture as { fetch?: typeof fetch }).fetch ?? globalThis.fetch);
    return module.exports;
}
