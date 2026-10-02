/** One literal NAME=value per line. Values are never evaluated as shell commands. */
export function parseProfileEnvironment(text = ""): Record<string, string> {
    const entries: [string, string][] = [];
    for (const [index, line] of text.split(/\r?\n/).entries()) {
        if (!line.trim()) continue;
        const separator = line.indexOf("=");
        const name = line.slice(0, separator).trim();
        if (separator < 1 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || line.includes("\0")) {
            throw new Error(`Environment variables: line ${index + 1} must use NAME=value.`);
        }
        entries.push([name, line.slice(separator + 1)]);
    }
    return Object.fromEntries(entries);
}

/** Windows variable names are case insensitive; remove inherited variants before overriding. */
export function windowsGameEnvironment(inherited: NodeJS.ProcessEnv, custom: Record<string, string>): NodeJS.ProcessEnv {
    const entries = new Map<string, [string, string | undefined]>();
    for (const [key, value] of [...Object.entries(inherited), ...Object.entries(custom)]) {
        entries.set(key.toUpperCase(), [key, value]);
    }
    return Object.fromEntries(entries.values());
}
