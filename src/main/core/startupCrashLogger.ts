import { app } from 'electron';
import fs from 'fs';
import path from 'path';

function resolveCrashLogPath(): string {
    let userDataPath: string;

    try {
        userDataPath = app.getPath('userData');
    } catch {
        userDataPath = app.getAppPath();
    }

    return path.resolve(userDataPath, 'logs', 'startup-crash.log');
}

function formatError(error: unknown): string {
    if (error instanceof Error) {
        return error.stack || `${error.name}: ${error.message}`;
    }

    try {
        return JSON.stringify(error);
    } catch {
        return String(error);
    }
}

export function writeStartupCrashLog(reason: string, error: unknown): void {
    try {
        const logPath = resolveCrashLogPath();
        fs.mkdirSync(path.dirname(logPath), { recursive: true });
        fs.appendFileSync(
            logPath,
            [
                `[${new Date().toISOString()}] ${reason}`,
                formatError(error),
                `platform=${process.platform} arch=${process.arch} electron=${process.versions.electron} node=${process.versions.node}`,
                '',
            ].join('\n'),
            'utf-8',
        );
    } catch {
        // Last-resort crash logging must never become another startup failure.
    }
}

export function setupStartupCrashLogger(): void {
    process.on('uncaughtException', (error) => {
        writeStartupCrashLog('uncaughtException', error);
    });

    process.on('unhandledRejection', (reason) => {
        writeStartupCrashLog('unhandledRejection', reason);
    });
}
