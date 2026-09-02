# MoxPod

Extension Chrome / Firefox pour jouer à Magic en pod Commander sur le playtest
Moxfield, **en voyant le board des adversaires** — pas seulement leurs points
de vie.

**→ [Télécharger la dernière version](https://github.com/Tyrenax/moxpod/releases/latest)**

Fork de [MoxMox](https://github.com/natefinch/moxmox) par Nate Finch (MIT), qui
apporte tout le socle multijoueur. MoxPod y ajoute la vue spectateur.

---

## Installation

> **Tout le monde dans la pod doit avoir MoxPod installé**, et de préférence la
> même version. L'extension vérifie les nouvelles releases toute seule et
> affiche un badge orange `UP` sur son icône quand une mise à jour existe.

### Chrome / Edge / Brave

1. Télécharge `moxpod-chrome-vX.Y.Z.zip` depuis
   [la dernière release](https://github.com/Tyrenax/moxpod/releases/latest).
2. **Décompresse-le dans un dossier que tu gardes.** Ne le supprime pas
   ensuite : Chrome lit dedans en permanence.
3. Va sur `chrome://extensions`, active **Mode développeur** (en haut à droite).
4. Clique **Charger l'extension non empaquetée** et choisis le dossier
   décompressé.

### Firefox

Télécharge `moxpod-firefox-vX.Y.Z.zip`, puis `about:debugging` → **Ce Firefox**
→ **Charger un module temporaire** → choisis le zip.

> Sous Firefox, l'extension disparaît à chaque redémarrage du navigateur.
> C'est une limite de Mozilla pour les extensions non signées, pas un bug.

### Mettre à jour

Retélécharge le zip, écrase le contenu du dossier, puis clique l'icône
**recharger** de MoxPod dans `chrome://extensions`. Rafraîchis les onglets
Moxfield ouverts.

---

## Utilisation

1. Chaque joueur ouvre son deck en playtest :
   `https://moxfield.com/decks/<id>/goldfish`
2. L'hôte clique **Create…** dans le menu MoxPod, choisit **Traditional** et le
   nombre de joueurs (2 à 4), et partage le code.
3. Les autres cliquent **Join…** et entrent le code.

Le board de l'adversaire s'affiche en haut de l'écran :

| | |
|---|---|
| Changer de joueur | Onglets, flèches ← →, ou touches **1-4** |
| Répartition de l'écran | Bouton **50/50** (40/60 · 50/50 · 60/40), ou glisser le bord |
| Vue « d'en face » | Bouton **⇅** |
| Détail d'une carte | Clic sur la carte |
| Cimetière / exil | Pastilles en bas, cliquables |
| Masquer le panneau | **Échap**, ou le bouton ✕ |
| Le rouvrir | Icône de l'extension → **Afficher le panneau** |

### Ce qui est visible, ce qui ne l'est pas

Visible : le champ de bataille avec les positions, les cartes engagées, les
marqueurs, les modifications de force/endurance et de loyauté, les points de
vie, le nombre de cartes en main, le cimetière, l'exil, la zone de commandement.

**Jamais visible** : le contenu de la main et de la bibliothèque. Seul leur
nombre circule. Une main ne se montre que si son propriétaire la révèle
explicitement.

MoxPod est en **lecture seule** : il n'écrit jamais rien dans la partie de
quelqu'un d'autre. Chacun applique ses propres effets sur ses propres cartes,
exactement comme sur une vraie table. La seule exception est la demande de
carte (« Demander » sur une carte d'un cimetière adverse), que le propriétaire
doit accepter.

---

## Développement

```bash
npm install
npm run build          # -> dist/chrome/ et dist/firefox/
npm test               # 198 tests
npm run package        # -> release/*.zip
```

Console de dev intégrée : **Ctrl+Shift+D** sur une page de playtest. Elle donne
le log de toutes les frames, les stats de synchro, un **simulateur
d'adversaires** pour tout tester seul, et un export JSON à joindre à un rapport
de bug.

Relais local pour tester à deux onglets sans dépendre du serveur public :

```bash
npm run relay          # puis Ctrl+Shift+D -> Setup -> Local (8787)
```

Architecture, protocole réseau et limites connues : **[MOXPOD.md](MOXPOD.md)**.

### Publier une release

```bash
npm version patch                 # bump package.json + manifeste + tag
git push origin main              # d'abord la branche
git push origin v0.1.2            # PUIS le tag, seul
```

GitHub Actions construit, teste, empaquette et publie la release avec les zips.
Le workflow refuse de publier si les tests échouent ou si le tag ne correspond
pas à la version du manifeste.

> **Pousse le tag seul, pas avec `--follow-tags`.** GitHub ne déclenche aucun
> workflow quand plus de trois tags arrivent dans le même push. Ce dépôt porte
> les tags hérités de MoxMox, donc `--follow-tags` en pousse plusieurs d'un
> coup et la release ne part jamais — c'est exactement ce qui est arrivé à
> v0.1.1, taguée mais jamais publiée.

---

## Limites connues

- Le playtest Moxfield est entièrement côté client : **rien n'est arbitré**.
  N'importe qui peut afficher un board faux. C'est un outil pour jouer entre
  gens de confiance, pas un moteur de règles.
- Moxfield peut casser l'intégration en redéployant son site. C'est un risque
  hérité de MoxMox et il est permanent.
- Sur une carte recto-verso, seule la face avant est illustrée sur le board
  (les deux faces sont lisibles dans le détail).
- Les jetons personnalisés sans identifiant Scryfall s'affichent en cadre
  texte au lieu d'une image.

## Licence

MIT, comme MoxMox. Voir [LICENSE](LICENSE) — le copyright d'origine est celui
de Nate Finch.
