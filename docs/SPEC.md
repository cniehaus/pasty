# Pasta – Projektrahmen und Spezifikation

Stand: 27.11.2026

## 1. Ziel

Pasta ist ein Screenshot- und Annotationswerkzeug mit Textbaustein- und
Clipboard-Manager. Vorbild ist Screenpresso, der Funktionsumfang ist aber bewusst
klein und einfach gehalten.

Typischer Anwendungsfall: Eine Anleitung für Kolleginnen und Kollegen
erstellen – Screenshot aufnehmen, Schritte 1, 2, 3 markieren, kurz beschriften,
in eine E-Mail einfügen.

## 2. Zielgruppe

- Schulleitung und Verwaltung einer Schule – keine IT-Profis.
- Konsequenz: sofort verständliche Bedienung, deutsche Oberfläche, sinnvolle
  Voreinstellungen, kaum Konfiguration nötig.
- Installation durch den Projektverantwortlichen bzw. die Schul-Admins.

## 3. Rahmenbedingungen

| Thema | Festlegung |
| --- | --- |
| Lizenz | GPL-3.0, Open Source auf GitHub |
| Datenhaltung | Ausschließlich lokal. Keine Cloud, kein Konto, keine Telemetrie. |
| Plattformen | **macOS zuerst**, Windows 11 wird von Anfang an mitgedacht |
| Technik | Tauri 2: Kern in Rust, Oberfläche/Zeichenfläche in TypeScript |
| Sprache der UI | Deutsch (Struktur für spätere Übersetzungen vorsehen) |
| Mail-Programme | Outlook, Thunderbird, Apple Mail – über systemweite Integration (Zwischenablage, Tastenkürzel), **keine** Plugins/Add-ins |

### Architekturprinzipien

- **Viel Logik in Rust:** Aufnahme, Speichern, Bildexport, Zwischenablage und
  später die gesamte Textbaustein-Logik. Der TypeScript-Teil beschränkt sich im
  Wesentlichen auf die Zeichenfläche und die UI. (Ziel ist auch, dass der
  Projektverantwortliche dabei Rust lernt – Rust-Code gut lesbar halten und
  kommentieren.)
- **Plattformcode hinter Schnittstellen:** Bildschirmaufnahme, Hotkeys,
  Tastatur-Hook usw. werden im Rust-Kern über gemeinsame Traits abstrahiert,
  mit Implementierungen für macOS und Windows.
- **CI ab dem ersten Tag:** GitHub Actions baut für macOS und Windows, damit
  nichts unbemerkt nur auf einer Plattform funktioniert.
- Keine plattformspezifischen Annahmen bei Tastenkürzeln (⌘ vs. Strg), Pfaden
  oder Schriftarten.

## 4. Phase 1 – MVP

Ziel: Bildschirmfotos aufnehmen und mit Text und Nummern 1/2/3/4 annotieren.

### 4.1 Aufnahme

- Auslösen per globalem Tastenkürzel (Vorschlag: ⌘⇧2 bzw. Strg+Umschalt+2)
  und über ein Tray-/Menüleisten-Icon.
- **Bildschirm einfrieren:** Beim Auslösen wird zuerst der ganze Bildschirm
  aufgenommen und als Standbild im Vollbild angezeigt. Darauf wird der Bereich
  markiert. So ändert sich nichts mehr, während man auswählt.
- **Auswahl-Overlay** (Vorbild: Screenpresso):
  - Standbild leicht abgedunkelt, der markierte Bereich erscheint hell mit
    farbigem Rahmen.
  - Fadenkreuz: horizontale und vertikale Hilfslinie über den ganzen Bildschirm
    an der Mausposition.
  - Anzeige der Auswahlgröße in Pixeln (z. B. „527 × 646“).
  - Escape bricht ab.
- Nach der Aufnahme öffnet sich der Editor.

### 4.2 Editor

- **Nummernmarker:** Klick setzt einen Kreis mit Zahl; die Zahl zählt
  automatisch hoch (1, 2, 3 …). Standard: roter Kreis, weiße Zahl. Farbe
  wählbar.
- **Text:** Text an beliebiger Stelle; Größe und Farbe wählbar; optional
  weißer Hintergrundkasten für Lesbarkeit.
- Objekte auswählen, verschieben, löschen.
- Rückgängig / Wiederholen.

### 4.3 Ausgabe

- **Kopieren** (Button und ⌘C bzw. Strg+C): fertiges Bild in die
  Zwischenablage, direkt in Outlook, Thunderbird und Apple Mail einfügbar.
- **Speichern** als PNG, standardmäßig in `Bilder/Pasta` (wird bei Bedarf
  angelegt); alternativ „Speichern unter …“.

### 4.4 Nicht im MVP

Alles aus den folgenden Phasen, außerdem: Video/GIF-Aufnahme (generell nicht
geplant).

## 5. Roadmap

| Phase | Inhalt |
| --- | --- |
| **1 – MVP** | Bereichsaufnahme, Editor mit Nummernmarkern und Text, Kopieren/Speichern |
| **2 – Editor ausbauen** | Pfeil/Linie, Ellipse/Rechteck (Einkreisen), Nummernmarker mit Zeigerlinie, Buchstaben-Marker (A, B, C), Sprechblasen, Unkenntlichmachen/Pixeln, Zuschneiden, **Timer-Aufnahme** (3 s und 10 s; nach Ablauf wird der Bildschirm eingefroren, dann Bereich markieren – damit lassen sich z. B. aufgeklappte Menüs aufnehmen), **Lupe** im Auswahl-Overlay (vergrößerter Ausschnitt mit Pixelraster für pixelgenaues Markieren), weitere Aufnahmearten (Fenster, ganzer Bildschirm) |
| **3 – Textbausteine** | Systemweite Textexpansion mit Kürzeln im Format `@@kürzel`, Platzhalter (Datum, Uhrzeit …), Auswahlfenster per Tastenkürzel |
| **4 – Clipboard-Verlauf** | Verlauf für Texte und Bilder, inkl. Screenshots aus Pasta |
| **5 – Gemeinsame Nutzung** | Gemeinsame Bausteine aus einer Datei auf dem Netzlaufwerk (zusätzlich zu privaten), Platzhalter aus einem Benutzerprofil (`{Name}`, `{Funktion}`) |
| **Später** | Windows-Installer für zentrale Verteilung (MSI), Code-Signing/Notarisierung, ggf. Bild-im-Bild (zweiten Screenshot einfügen) – vorerst zurückgestellt |

## 6. Offene Fragen (werden in der jeweiligen Phase geklärt)

- **Phase 3:**
  - Ersetzung sofort nach vollständigem Kürzel oder erst nach Leerzeichen/Tab?
    (Vorschlag: sofort)
  - Einfügen über die Zwischenablage (Kürzel löschen → Baustein in die
    Zwischenablage → Einfügen simulieren → alte Zwischenablage wiederherstellen)?
    Nötig für formatierten Text und Bilder.
  - Formatierte Bausteine (fett, Links, Signatur mit Logo)?
  - Welche Platzhalter: Datumsformate, Wochentag, Kalenderwoche, „heute + n
    Tage“, Abfragefelder, Cursorposition?
- **Verteilung:** Code-Signing für macOS (Apple-Developer-Account) und Windows
  (SmartScreen) – nötig oder nicht?

## 7. Bekannte technische Herausforderungen

- **macOS-Berechtigungen:** Bildschirmaufnahme (ScreenCaptureKit) und später
  Bedienungshilfen (Tastatur-Hook für Textexpansion) erfordern
  Nutzerfreigaben. Die App muss verständlich durch diese Freigaben führen.
- **Overlay zur Bereichsauswahl:** Transparentes, randloses Fenster über allen
  anderen Fenstern, perspektivisch über mehrere Monitore und mit
  unterschiedlicher Skalierung (Retina/HiDPI).
- **Zwischenablage mit Bildern:** Format muss in allen drei Mail-Programmen
  korrekt ankommen.
- Reife der Rust-Crates für Aufnahme, Hotkeys und Tastatur-Hooks wird vor
  Beginn der jeweiligen Phase geprüft.
