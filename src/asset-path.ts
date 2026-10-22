// Configure before importing the editor; all fonts are served by this application.
declare global { interface Window { EXCALIDRAW_ASSET_PATH: string } }
window.EXCALIDRAW_ASSET_PATH = new URL('/fonts/', window.location.href).href;
export {};
