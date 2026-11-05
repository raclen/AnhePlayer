import '@infra/tauriBridge/autoInject';

import React from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router';

import bootstrapMainWindow from '../bootstrap/mainWindow';
import router from './router';

document.body.dataset.window = 'main';

const container = document.getElementById('root');
if (!container) {
    throw new Error('Root element not found');
}

const root = createRoot(container);
let appMounted = false;

// 先显示启动状态，再执行可能包含磁盘/网络 IPC 的 bootstrap，避免长时间白屏。
root.render(
    <div
        style={{
            display: 'grid',
            placeItems: 'center',
            height: '100vh',
            // 使用主题 token，默认值与旧硬编码值一致，浅色主题下不会先闪深色
            background: 'var(--color-bg-base, #121212)',
            color: 'var(--color-text-secondary, #a1a1aa)',
            fontFamily: 'var(--font-family, "Segoe UI", sans-serif)',
            fontSize: 14,
        }}
    >
        正在启动 AnhePlayer…
    </div>,
);

function renderErrorFallback(error: any, mode: 'error' | 'timeout' = 'error') {
    const errorMsg =
        error instanceof Error ? `${error.name}: ${error.message}\n${error.stack}` : String(error);
    const isTimeout = mode === 'timeout';
    root.render(
        <div
            style={{
                padding: 32,
                fontFamily: 'Segoe UI, sans-serif',
                background: '#18181b',
                color: '#f4f4f5',
                height: '100vh',
                boxSizing: 'border-box',
                overflow: 'auto',
            }}
        >
            <h2 style={{ color: '#ef4444', marginTop: 0 }}>
                {isTimeout
                    ? '⏱️ 初始化超时 (Bootstrap Timeout)'
                    : '⚠️ 播放器初始化异常 (Renderer Error)'}
            </h2>
            <p style={{ color: '#a1a1aa' }}>
                {isTimeout
                    ? '初始化长时间未完成，可能是磁盘或后台服务响应缓慢。可以点击下方按钮重新加载：'
                    : '如果在启动过程中发生错误，请将以下堆栈信息反馈：'}
            </p>
            <pre
                style={{
                    background: '#09090b',
                    padding: 16,
                    borderRadius: 8,
                    border: '1px solid #27272a',
                    color: '#f87171',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-all',
                    fontSize: 13,
                }}
            >
                {errorMsg}
            </pre>
            <button
                style={{
                    marginTop: 16,
                    padding: '8px 16px',
                    borderRadius: 6,
                    background: '#3b82f6',
                    color: '#fff',
                    border: 'none',
                    cursor: 'pointer',
                }}
                onClick={() => window.location.reload()}
            >
                重新加载应用
            </button>
        </div>,
    );
}

window.addEventListener('error', (event) => {
    console.error('[MainWindow Error]', event.error || event.message);
    if (!appMounted) {
        renderErrorFallback(event.error || event.message);
    }
});

window.addEventListener('unhandledrejection', (event) => {
    console.error('[MainWindow UnhandledRejection]', event.reason);
    if (!appMounted) {
        renderErrorFallback(event.reason);
    }
});

// 启动兜底：bootstrap 卡死时给出可重试的出口；若随后初始化成功会自动切换为正常界面
const BOOTSTRAP_TIMEOUT = 20_000;
const bootstrapTimeoutTimer = setTimeout(() => {
    if (appMounted) return;
    console.error('[MainWindow Bootstrap Timeout]');
    renderErrorFallback(
        new Error(`bootstrap 在 ${BOOTSTRAP_TIMEOUT / 1000} 秒内未完成`),
        'timeout',
    );
}, BOOTSTRAP_TIMEOUT);

bootstrapMainWindow()
    .then(() => {
        clearTimeout(bootstrapTimeoutTimer);
        appMounted = true;
        root.render(
            <React.StrictMode>
                <RouterProvider router={router} />
            </React.StrictMode>,
        );
    })
    .catch((err) => {
        clearTimeout(bootstrapTimeoutTimer);
        console.error('[MainWindow Bootstrap Failed]', err);
        renderErrorFallback(err);
    });
