# Pasta 🍝

**Pasta** ist ein schlankes Screenshot- und Annotationswerkzeug mit Textbaustein-
und Clipboard-Manager für macOS und Windows 11 – gedacht für Schulleitung und
Verwaltung, die schnell verständliche Anleitungen und E-Mails erstellen wollen.

> Der Name ist ein Wortwitz: *paste* + Pasta.

## Was Pasta können soll

- **Screenshots** per Tastenkürzel aufnehmen und mit wenigen Klicks beschriften:
  Schritt-Nummern (1, 2, 3 …), Texte, später Pfeile, Rahmen, Sprechblasen und
  Unkenntlichmachen.
- Ergebnis direkt **in die Zwischenablage** kopieren und in Outlook, Thunderbird
  oder Apple Mail einfügen – oder als PNG speichern.
- **Textbausteine** systemweit per Kürzel (`@@gruss`) einfügen, inklusive
  Platzhaltern wie aktuellem Datum und Uhrzeit.
- **Clipboard-Verlauf** für Texte und Bilder.

Alles bleibt **lokal** – keine Cloud, kein Konto, keine Telemetrie.

## Status

🚧 In Planung. Siehe [docs/SPEC.md](docs/SPEC.md) für Projektrahmen und Roadmap.

## Technik

- [Tauri 2](https://tauri.app/) – Kern in **Rust**, Oberfläche/Zeichenfläche in **TypeScript**
- Zielplattformen: macOS (zuerst), Windows 11

## Entwicklung

Voraussetzungen: [Rust](https://rustup.rs/), [Node.js](https://nodejs.org/) (LTS),
auf macOS die Xcode Command Line Tools, auf Windows die
[Tauri-Voraussetzungen](https://tauri.app/start/prerequisites/).

```sh
npm install
npm run tauri dev     # App im Entwicklungsmodus starten
npm run tauri build   # Installer bauen (DMG bzw. MSI/EXE)
```

Pasta erscheint als Icon in der Menüleiste (macOS) bzw. im Infobereich
(Windows). Aufnahme per **⌘⇧2** bzw. **Strg+Umschalt+2**.

Projektstruktur:

| Pfad | Inhalt |
| --- | --- |
| `src-tauri/` | Rust-Kern (Aufnahme, Zwischenablage, Hotkeys, Speichern …) |
| `src/` | Oberfläche in TypeScript (Auswahl-Overlay, Editor) |
| `docs/SPEC.md` | Projektrahmen und Roadmap |
| `assets/icon/` | Icon-Quellen als SVG; `npm run icons` erzeugt daraus alle Icon-Dateien |

## Lizenz

[GPL-3.0](LICENSE)
