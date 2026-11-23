# Live Tolk

Webapp die gesproken woord direct vertaalt. Drie standen:

- **Gesprek** – meerdere personen op één apparaat, ieder met eigen taal en spreekknop.
- **Op afstand** – twee telefoons verbinden via een gesprekscode; ieder ziet en hoort de ander in de eigen taal.
- **Toespraak** – één spreker, doorlopende vertaling op een groot scherm.

Werkt in Google Chrome of Microsoft Edge (spraakherkenning). Vereist internet.

## Online zetten met GitHub Pages
1. Upload `index.html` en `.nojekyll` naar een repository (bijv. `live-tolk`).
2. Ga naar **Settings → Pages**, kies bij *Source* "Deploy from a branch", branch `main`, map `/ (root)`, en klik **Save**.
3. Na 1–2 minuten staat de app op `https://<gebruikersnaam>.github.io/live-tolk/`.

## Teksten bewaren (tussenstation)
De app stuurt zinnen naar een Cloudflare Worker (`worker/worker.js`), die ze in de privé-repository
`live-tolk-data` zet. De GitHub-sleutel staat alleen als geheime instelling in Cloudflare, nooit in deze
openbare code. Zie de uitleg bovenin `worker/worker.js` voor de instellingen.
