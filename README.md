# Mods

Mod di Claude Code di Damiano Sommavilla. Il repo è un marketplace: ogni mod sta nella sua cartella ed è elencata in `.claude-plugin/marketplace.json`.

| Mod | Cosa fa |
| --- | --- |
| [progress-bar](progress-bar/) | Banda animata sopra il prompt: avanzamento del flow, attività del turno, RAM e subagenti con i token. |

## Installazione

In una sessione `claude` nel terminale:

```
/plugin install progress-bar --marketplace DamianoSrb/Mods
```

Rispondi `y` per aggiungere il marketplace e scegli lo scope utente. Da quel momento la mod si carica in ogni sessione, anche nell'app desktop.
