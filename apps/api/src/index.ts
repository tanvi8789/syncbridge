import { startApi } from "./server";

/*
 * Standalone entry point for development (`npm run dev`) and for
 * running the engine without the desktop app. The desktop app calls
 * startApi() itself instead.
 */
startApi()
    .then((api) => {
        const shutdown = (): void => {
            void api.stop().then(() => process.exit(0));
        };

        process.on("SIGINT", shutdown);
        process.on("SIGTERM", shutdown);
    })
    .catch((error) => {
        console.error("[API] Failed to start:", error);

        process.exit(1);
    });
