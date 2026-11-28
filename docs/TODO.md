# Pasta – TODO

Offene Punkte, grob nach Bereich sortiert. Erledigtes wird abgehakt und
wandert bei Gelegenheit in die Roadmap der [SPEC](SPEC.md).

Stand: 28.11.2026 (Version 0.1.5)

## Editor und Aufnahme

- [ ] **Collage** aus mehreren Bildern der Miniaturleiste
- [ ] **Hilfslinien bei der Auswahl** – Variante klären:
  - Lupe mit Pixelraster neben dem Mauszeiger
  - Einrasten an Fenster- und Elementkanten
  - Auswahl nachjustieren (Anfasser, Pfeiltasten, ↩ bestätigt)
  - Größe genau eingeben (z. B. 800 × 600)
- [x] **Timer-Aufnahme** 3 s / 10 s (Countdown in der Menüleiste)
- [x] **Zuschneiden** im Editor (Seitenverhältnisse, Drittel-Raster, zerstörungsfrei)
- [ ] **Sprechblasen**
- [x] **Fensteraufnahme** (Fenster im Auswahlmodus anklicken; ohne verdeckende Fenster)
- [ ] Strichbreite als **Zahl** statt nur S/M/L
- [x] **Textmarker** (multiplizierend, eigene Markerfarben)
- [x] Größe **XL** für alle Werkzeuge
- [ ] **Texterkennung (OCR)**: Text im Bildschirmfoto markieren/kopieren, automatisch schwärzen – Bedarf klären
- [ ] macOS: Während der Editor offen ist, Dock-Symbol und eigene Menüleiste
      (Über Pasta, Bearbeiten, Fenster) und Erreichbarkeit per ⌘-Tab
- [ ] **Scrollende Aufnahme** – bewusst zuletzt (am aufwändigsten)

## Textbausteine und Einfügen

- [ ] **Textexpansion** `@@kürzel` systemweit – offen: sofort oder nach
      Leerzeichen ersetzen, formatierte Bausteine, welche Platzhalter
- [ ] **Einfüge-Palette** (Bausteine, gespeicherte Bilder, Verlauf) –
      Rückmeldung zum Mockup steht aus
- [ ] Baustein mit **`{Bildschirmfoto}`** (Text und beschriftetes Bild in einem Schritt)
- [ ] **Clipboard-Verlauf**
- [ ] **Gemeinsame Bausteine** vom Netzlaufwerk, Platzhalter aus Benutzerprofil

## Vertretungsplan-Mails

- [ ] Untis-Text erkennen und als lesbare Übersicht pro Lehrkraft einfügen
      (Prototyp des Parsers funktioniert, auch mit Text aus bereits
      verschickten Mails)
  - [ ] Kopie **direkt aus Untis** prüfen (Tabs? HTML-Tabelle?)
  - [ ] Bedeutung des Sternchens (`*GRS`) klären
  - [ ] Druckt die Sekretärin die Mail? (dann eine Seite pro Lehrkraft)
  - [ ] Felder „zur Zeit in Raum …“ und Notiz pro Lehrkraft abfragen

## Tests und Verteilung

- [ ] Rückmeldung vom Mac-Tester (Aufnahme ab 0.1.3)
- [ ] Windows: tritt „länger gedrückt halten zum Verschieben“ noch auf?
- [ ] **Code-Signing** entscheiden: Apple-Developer-Account (99 $/Jahr)
      würde „Dennoch öffnen“ und das erneute Erteilen der
      Bildschirmaufnahme-Berechtigung nach jedem Update ersparen;
      Windows-Zertifikat gegen die SmartScreen-Warnung
- [ ] Optional: alte Git-Tags `v0.1.0`–`v0.1.2` löschen
