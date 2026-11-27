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

## Lizenz

[GPL-3.0](LICENSE)
