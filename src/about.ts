// "About Pasta" window.
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import logoUrl from "../assets/icon/app-icon.svg";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

$<HTMLImageElement>("logo").src = logoUrl;
void getVersion().then((v) => ($("version").textContent = `Version ${v}`));
$("project").addEventListener("click", () => void invoke("open_project_page"));
$("close").addEventListener("click", () => void getCurrentWindow().close());
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" || e.key === "Enter") void getCurrentWindow().close();
});
