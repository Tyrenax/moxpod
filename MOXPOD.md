# MoxPod

Fork de [MoxMox](https://github.com/natefinch/moxmox) (Nate Finch, MIT) qui
ajoute au playtest Moxfield la **vue du board des adversaires** en Commander.

---

## 1. L'objectif

Jouer à Magic en pod via le playtest Moxfield, et **voir ce que les autres ont
en jeu** — pas seulement leurs points de vie.

Contraintes posées au départ :

| Besoin | Décision |
|---|---|
| De la place pour jouer | Écran partagé réglable, 40/60 · 50/50 · 60/40, redimensionnable à la souris |
| Un seul adversaire à la fois | Onglets + flèches ← → + touches 1-4, un board plein cadre |
| Vue « d'en face » | Bouton miroir (rotation 180°) |
| **Le point central : lire les cartes** | Marqueurs, −1/−1 et +1/+1, engagée, ne se dégage pas, loyauté, texte complet |
| Les malus restent gérés par leur propriétaire | On **affiche**, on n'écrit jamais rien chez l'autre |
| Vie / main / cimetière / exil lisibles | Barre de constantes + zones parcourables carte par carte |
| Prendre une carte dans un cimetière adverse | Demande → le propriétaire accepte → transfert par le mécanisme de don existant |
| Rester privé | La main et la bibliothèque ne partent **jamais** sur le réseau, seulement leur nombre |

---

## 2. Ce qui existait déjà, et ce qui manquait

MoxMox a deux modes, et tout se jouait là :

| | `shared` (DanDan, 2 joueurs) | `traditional` (Commander, 2-4) |
|---|---|---|
| Battlefield | mirroring complet | **rien** |
| Vie / taille de main | oui | oui |
| Cimetière / exil | partagé | consultable à la demande |
| Main | — | reveal ciblé |

La sérialisation d'un champ de bataille existait donc déjà, mais uniquement
pour le mode où **les deux joueurs partagent un seul board**. En Commander ça
ne convient pas : ce mode écrit réellement les cartes adverses dans ton propre
state React.

**Le choix structurant de MoxPod** : ne jamais écrire une carte distante dans
Moxfield. On lit l'état adverse et on le redessine dans notre propre DOM. Un
bug de synchro peut abîmer l'affichage, jamais ta partie ni ta sauvegarde.

Corollaire agréable : on n'a pas besoin des `syncId` de MoxMox (leur identité
cross-client, qui exige l'initialisation d'une bibliothèque partagée). Le
`zoneId` local de Moxfield, toujours présent, suffit comme clé.

---

## 3. Architecture

```
   TON NAVIGATEUR                                 CELUI D'EN FACE
   ┌──────────────────────────┐                   ┌──────────────────────────┐
   │ MAIN world               │                   │                          │
   │  moxfield/adapter.js     │                   │                          │
   │   _getBoardSnapshot() ───┼──┐                │                          │
   │   (hook fiber React)     │  │                │                          │
   ├──────────────────────────┤  │ postMessage    │                          │
   │ ISOLATED world           │  ▼                │                          │
   │  board/batcher.js  ──────┼─ encode ─ diff ───┼──► relais ──► store.js   │
   │  board/store.js    ◄─────┼──────── apply ────┼──◄            panel.js   │
   │  board/panel.js          │                   │                          │
   └──────────────────────────┘                   └──────────────────────────┘
```

### Modules ajoutés

| Fichier | Rôle |
|---|---|
| `src/board/protocol.js` | Constantes du format réseau, clés compactes, actions |
| `src/board/serialize.js` | encode / diff / apply / hydrate — **pur**, sans DOM |
| `src/board/batcher.js` | Coalescence des changements + seau à jetons |
| `src/board/store.js` | État reçu, un snapshot par joueur, détection de désync |
| `src/board/panel.js` | Le panneau spectateur (onglets, board, zones, détail) |
| `src/board/integration.js` | Câblage ; `content.js` ne gagne que 6 points d'appel |
| `src/debug/tracer.js` | Traçage structuré, compteurs, timings, export |
| `src/debug/panel.js` | Console de dev (Ctrl+Shift+D) |
| `src/debug/simulator.js` | Adversaires factices déterministes |
| `src/moxpod.css` | Styles, isolés de ceux de MoxMox |
| `server/dev-relay.js` | Relais local, zéro dépendance |

### Modules modifiés

- `src/moxfield/adapter.js` — `get-board-state`, `gift-to-player`,
  `_getZoneCards` étendu aux zones parcourables
- `src/content.js` — création de la feature, 6 points d'appel, override du relais
- `src/content-main.js` — `gift-to-player` dans `SYNC_COMMANDS`
- `manifests/base.json`, `build.js`, `package.json` — nom, CSS, scripts
- `tests/build/build-smoke.test.js` — correction d'un bug de chemin Windows
  (`new URL().pathname` donne `/C:/…`, que `join()` transformait en `C:\C:\…`)

---

## 4. Le protocole

On se greffe sur le type `zone-sync` de MoxMox. Les nouvelles `action` passent
bien — mais **attention, le relais public filtre aussi les champs par type**
(`RELAY_FIELDS` dans `server/src/index.js`) : il reconstruit chaque message en
ne gardant que les clés autorisées et jette silencieusement le reste.

Pour `zone-sync`, passent uniquement : `action`, `zone`, `cardId`,
`scryfallId`, `syncId`, `pctX`, `pctY`, `fromZone`, `toZone`, `updates`,
`syncIds`, `cards`, `targetId`, `gift`.

Un `snapshot` ou un `delta` posé au premier niveau **est supprimé** : la frame
arrive avec son action et sans charge utile. `updates` est whitelisté et
accepte du JSON arbitraire, donc **tous les payloads MoxPod voyagent dedans**,
via `packEnvelope` / `unpackEnvelope` (`src/board/protocol.js`) — le seul
endroit du code où cette contrainte est encodée.

`unpackEnvelope` accepte aussi la forme non emballée, pour qu'un worker forké
sans ce filtre fonctionne sans changer une ligne de client.

| Action | Sens | Contenu |
|---|---|---|
| `board-full` | → tous | Snapshot complet + dictionnaire |
| `board-delta` | → tous | Ops incrémentales |
| `board-request` | → ciblé | « renvoie-moi ton board » |
| `board-claim-request` | → ciblé | Demande de carte |
| `board-claim-deny` | → ciblé | Refus |

### Le dictionnaire

L'identité d'une carte (nom, texte d'oracle, ligne de type, F/E) est immuable
et verbeuse. Elle voyage **une seule fois**, dans un `dict` indexé par
impression, que le receveur garde en cache pour la session. Quatre exemplaires
de Foudre partagent une entrée.

Les deltas ne transportent ensuite que l'état volatile, en clés d'une lettre :

```js
{ i: '72', k: '<scryfall-id>', s: { x: .42, y: .18, t: 1, c: 3, p: -1, g: -1 } }
//  zoneId  impression           pos.x pos.y  engagée  marqueurs  −1/−1
```

Les positions sont exprimées en **fraction du battlefield, centre de la
carte** — la fenêtre d'en face n'a pas la même taille que la tienne.

Mesures réelles, board de 40 permanents sur 25 impressions différentes, avec
un texte d'oracle plein sur chaque carte :

| | Octets |
|---|---|
| Snapshot complet | **8 062** (dont 5 606 de dictionnaire) |
| Delta « j'engage une créature » | **92** |
| Delta « je dégage mes 40 permanents » | **889** |

Le plafond du relais est 65 536 octets : on a un facteur 8 de marge sur le cas
complet, et le dictionnaire — les deux tiers du poids — ne repart pas dans les
deltas.

---

## 5. Le vrai problème technique : le rate limit

Le relais impose, par connexion :

```js
MAX_MESSAGE_BYTES     = 65536   // 64 Ko
RATE_LIMIT_MAX_TOKENS = 5       // burst
RATE_LIMIT_REFILL_PER_SEC = 5   // 5 msg/s soutenus
```

MoxMox envoie **un message par carte modifiée**. Un untap step sur 6
permanents = 6 messages = seau vidé, throttle serveur à 250 ms. En pod à 4
c'est permanent.

MoxPod ne fait jamais de send par changement. On marque le board sale, on
agrège tout ce qui bouge dans une fenêtre de **350 ms**, et on dépense **un
seul jeton par flush**. Soit ~2,9 msg/s, ce qui laisse de la marge à
`life-sync` et `hand-count-sync` qui partagent le même seau.

Détails qui comptent :

- **Remboursement du jeton** si le flush n'avait finalement rien à envoyer
  (board immobile, ou lecture encore en vol). Sinon un board au repos affame
  le seau partagé.
- **Keyframe toutes les 15 s** : un snapshot complet périodique. Un spectateur
  arrivé en retard ou ayant perdu une frame se répare tout seul.
- **Delta vs complet** : si le delta dépasse 80 % du poids du snapshot
  complet, on envoie le complet — même prix, plus robuste.
- **Détection de trou** : chaque delta cite la révision sur laquelle il
  s'appuie. Si elle ne correspond pas, on **garde le board périmé à l'écran**
  (mieux qu'un écran vide) et on redemande un snapshot complet.

Test : 10 s de drag continu → 2,0 à 3,1 msg/s, jamais deux frames à moins de
300 ms d'intervalle.

---

## 6. Le module de dev — comment tester

C'est la partie à utiliser avant de distribuer quoi que ce soit.

### 6.1 Console de dev — `Ctrl+Shift+D`

Cinq onglets :

- **Log** — chaque événement (frames réseau, captures, diffs, rendus, erreurs),
  filtrable par catégorie / niveau / texte, avec pause.
- **Stats** — flushes, ratio complets/deltas, flushes à vide évités, attentes
  de jeton, octets, plus grosse frame.
- **Simulateur** — les adversaires factices (ci-dessous).
- **Boards** — par joueur : révision, permanents, impressions connues, frames
  reçues, **désyncs**, âge du dernier message.
- **Setup** — bascule de relais, sonde DOM, aide console.

En pied de fenêtre en permanence : débit board entrant/sortant, **jetons
restants**, révision courante, nombre d'erreurs.

**Export** produit un JSON autonome (environnement, compteurs, config, tout le
ring buffer). C'est ce que tu demandes à un pote quand il dit « ça marche
pas ».

Depuis la console navigateur : `window.moxpod.help()`.

### 6.2 Adversaires factices — tester seul

L'onglet Simulateur crée 1 à 3 joueurs qui jouent tout seuls : ils posent des
permanents, engagent, mettent des marqueurs, appliquent des −1/−1, tuent des
créatures, perdent des points de vie.

Deux choses le rendent utile plutôt que décoratif :

1. Il passe par le **vrai chemin** encode → diff → apply → store. Si la logique
   de diff casse, le simulateur le montre.
2. Il **emprunte les impressions de ton propre deck**, donc les cartes
   affichées sont réelles et les images se chargent. (Placeholders textuels si
   ton board est vide.)

Il est **déterministe** (PRNG à graine) : un bug se rejoue à l'identique.

Deux boutons de sabotage : `Injecter une désync` (avance la révision sans
prévenir → doit déclencher une resynchro) et `Injecter une carte inconnue`
(delta citant une impression absente du dictionnaire → doit afficher un cadre
« ? » sans casser le board).

### 6.3 Relais local — tester à deux sessions

```bash
npm run relay              # port 8787
npm run relay:verbose      # + chaque frame loguée
npm run relay:slow         # rate limit à 1/s, pour provoquer le throttling
npm run relay:lossy        # +150 ms de latence et 5 % de perte
```

Zéro dépendance (handshake et framing WebSocket écrits à la main), et il
reproduit le protocole du worker de prod : mêmes messages, mêmes `playerId`
(`p1`, `p2`…), même seau à jetons, même longueur minimale de clé joueur, et
surtout **le même whitelist de champs**. Ce dernier point est le plus
important : un relais de dev qui relaie tout laisse passer un protocole que le
vrai relais tronque, et la suite de tests reste verte pour rien.
`--no-sanitize` désactive le filtre, uniquement pour prouver qu'un bug vient
bien de lui.

**Procédure à deux sessions sur une seule machine :**

1. `npm run build` puis charger `dist/chrome/` dans `chrome://extensions`
   (mode développeur → « Charger l'extension non empaquetée »).
2. `npm run relay:verbose` dans un terminal.
3. Ouvrir ton deck en playtest :
   `https://moxfield.com/decks/QL9jtDuds0-O6k1N5d0bKA/goldfish`
4. `Ctrl+Shift+D` → onglet **Setup** → **Local (8787)**. La page recharge.
5. Créer une partie traditionnelle depuis le menu MoxMox, noter le code.
6. **Deuxième session** : nouveau profil Chrome (ou fenêtre de navigation
   privée avec l'extension autorisée en privé), charger la même extension,
   ouvrir un deck, régler le relais sur Local (8787), rejoindre avec le code.
7. Les deux onglets doivent afficher le board de l'autre. Le terminal du
   relais montre chaque frame.

> `ws://localhost` depuis une page `https://` fonctionne : Chrome et Firefox
> classent `localhost` comme origine de confiance, ce qui l'exempte du blocage
> de contenu mixte. C'est d'ailleurs pour ça que `http://localhost:8787/*`
> était déjà dans le manifeste amont.

Pour revenir au relais public : Setup → **Production**.

### 6.4 Tests automatisés

```bash
npm test          # 159 tests unitaires + intégration
npm run test:build # vérifie le bundle produit
```

**165 tests, tous verts.** Répartition :

| Fichier | Couvre |
|---|---|
| `tests/board-serialize.test.js` | encodage, dictionnaire, diff, apply, non-mutation, poids réseau, fuite de main/bibliothèque |
| `tests/board-sync.test.js` | batcher (coalescence, seau, keyframe, capture en échec), store, simulateur, tracer |
| `tests/relay-integration.test.js` | **bout en bout sur vraie WebSocket** : handshake, capacité, routage ciblé, partie longue sans désync, lien avec pertes |

Le test qui compte le plus est le dernier de `relay-integration` : 40 mutations
sur 12 permanents, puis comparaison **carte par carte** du board reçu avec le
board émis (position, engagement, marqueurs). Il lance le vrai
`server/dev-relay.js` en sous-processus — s'il passe, deux onglets marchent.

Bugs trouvés par ces tests pendant le développement :

1. Le simulateur avançait sa révision même quand un tick ne changeait rien →
   toutes les frames suivantes lues comme des trous (39 désyncs sur 60 ticks).
2. `injectGap()` bougeait la mauvaise variable et ne provoquait aucune désync.
3. Le batcher dépensait un jeton pour un flush vide.
4. `parseInt('1+*')` renvoie `1` : une endurance type Tarmogoyf s'affichait
   silencieusement comme `1`.

Et une classe entière de bugs que les tests **n'ont pas** attrapée jusqu'à ce
qu'une relecture la trouve : le relais de dev ne reproduisait pas le whitelist
de champs, donc toute la synchro passait en local et **rien** ne serait passé
sur le relais public. C'est corrigé, et `tests/relay-integration.test.js` a
maintenant une suite « relay field whitelist » qui vérifie explicitement qu'un
payload posé au premier niveau est bien détruit et que l'enveloppe survit.

---

## 7. Limites connues, à dire aux joueurs

1. **Aucune autorité.** Le playtest Moxfield est 100 % client. N'importe qui
   peut mentir sur son board. Pour une pod entre amis c'est sans importance,
   mais ce ne sera jamais un moteur de règles.
2. **Fragilité du hook React.** Moxfield redéploie un bundle, les sélecteurs
   de fiber cassent. Risque hérité de MoxMox, permanent. La sonde DOM de
   l'onglet Setup existe pour diagnostiquer vite.
3. **Le partage d'écran pousse le `body`.** Si une mise à jour de Moxfield
   casse le calage, la sonde DOM dit quel conteneur viser.
4. **Cartes double-face** : les deux faces sont transmises et lisibles dans le
   détail, mais seule la face avant est illustrée sur le board.
7. **Le claim est consenti, mais pas arbitré.** Le propriétaire voit une
   demande construite à partir de la carte réellement trouvée dans la zone
   annoncée (jamais à partir du texte envoyé par le demandeur), et le transfert
   est refusé si la carte n'est pas dans cette zone. Reste que c'est un accord
   entre joueurs, pas une règle appliquée.
5. **Tokens sans `scryfall_id`** : cadre textuel au lieu d'une image.
6. Le mode `shared` (DanDan) d'origine est intact et non touché.

---

## 8. Prochaines étapes possibles

- Fork du worker Cloudflare sur ton compte (`server/`, `wrangler deploy`) pour
  relever le rate limit et ajouter un snapshot serveur qui survit aux
  reconnexions. Une seule constante à changer côté client.
- Option « acceptation automatique des demandes de carte » pour les groupes
  qui se font confiance.
- Pile de la pioche / bibliothèque consultable si un effet le demande.
- Historique des actions adverses (ce qui a été joué au tour précédent).
