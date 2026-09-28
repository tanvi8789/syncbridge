export {};

declare global {
    interface Window {
        electronAPI: {
            selectFile(): Promise<
                string | null
            >;
            showInFolder(
                filePath: string
            ): Promise<void>;
            selectFolder(): Promise<
                string | null
            >;
            getPathForFile(
                file: File
            ): string;
            readClipboard(): Promise<string>;
            writeClipboard(
                text: string
            ): Promise<boolean>;
        };
    }
}
