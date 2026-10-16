# progress-bar

Una banda sempre visibile sopra il prompt di Claude Code che mostra a che punto è il lavoro: una barra colorata e animata, la RAM del computer e i subagenti con i loro token. Funziona da sola: non serve il plugin savvy-progress.

## Cosa fa

- **Barra colorata e animata**, in tre modi:
  - **flow**: un'attività pianificata in più passi. Titolo, barra a sfumatura viola → blu → verde acqua con una tacca per attività, fase (`Piano`, `Design`, `Attività 2/5`, `Revisione`) e percentuale.
  - **In lavoro**: un turno del modello è in corso. Barra animata viola → rosa → ambra, tempo trascorso e numero di tool chiamati.
  - **Pronto**: nessun turno in corso. Durata e tool dell'ultimo turno e, se c'era, il flow appena chiuso (`✓ <titolo>`).
- **Scheda RAM**, sempre visibile all'estremità destra della riga (larga 120 px; sotto i 500 px di riga solo la percentuale): memoria usata e totale (`8/16 GB`), letta subito all'avvio e poi ogni 10 secondi (mai due letture insieme). Su Windows prova PowerShell (`Get-CimInstance`, fino a 15 s), poi `typeperf` (contatore inglese, poi italiano) che legge solo la memoria disponibile e usa il totale dell'ultima lettura PowerShell; su Linux legge `/proc/meminfo`; su macOS `sysctl` e `vm_stat`. Una lettura fallita non si vede finché l'ultima riuscita ha meno di 60 secondi; dopo (o se nessuna è mai riuscita) la scheda mostra `RAM ?`. Il testo alternativo resta breve (`RAM 8/16 GB` o `RAM ?`); il motivo completo compare una volta nella trascrizione (`progress-bar: RAM unavailable: …`).
- **Vista agenti**: quando partono dei subagenti compare, tra la barra e la scheda RAM, il pulsante agenti compatto (`●▾3 · 45k`: `●` se qualcuno lavora, numero di agenti e token totali). Premendolo si apre una riga per agente con avanzamento, token usati e tempo (`3/5 · 12k tok · 1:20`); premendolo di nuovo si chiude.

## Tool per il modello

- `mcp__progress-bar__progress`: per chi orchestra. Campi: `title`, `total`, `done`, `phase` (`plan`, `design`, `delegate`, `review`, `close`), `tasks` (`[{ title, tier, after }]`) e `finished: true` alla fine. I campi omessi tengono il valore precedente; un `title` nuovo apre un nuovo flow.
- `mcp__progress-bar__step`: per i subagenti. Campi: `done`, `total`, `note`.

Se savvy-progress è installato, le chiamate a `mcp__savvy-progress__progress` e `mcp__savvy-progress__step` vengono osservate anche da questa banda.

## Opzioni

- `language`: `auto` (predefinito: segue la lingua di Claude Code, poi il locale del sistema), `it` oppure `en`.

## Installazione

In una sessione `claude` nel terminale:

```
/plugin install progress-bar --marketplace DamianoSrb/Mods
```

Rispondi `y` e scegli lo scope utente.

In sviluppo, senza installarlo:

```
claude --plugin-dir <cartella>
```
