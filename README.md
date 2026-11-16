# Loup-Garou gabonais

Un jeu de déduction en ligne, de 4 à 20 joueurs, inspiré du Loup-Garou et ancré dans un quartier de ville gabonaise. Chacun joue depuis son téléphone ; la partie se rejoint avec un code partagé sur WhatsApp.

La nuit, les Ndoki choisissent qui manger, pendant que le Nganga consulte les esprits, que le Policier met quelqu'un au poste et que le Marabout bénit un voisin. Tout le monde lance ensuite des rumeurs dans un chat anonyme, sous un pseudo de quartier tiré au hasard. Le jour, on débat au maquis, puis on vote en direct pour chasser un suspect.

## Déroulé d'une partie

1. **Salon** : l'hôte crée la partie et partage le code (ou le lien `/j/CODE`) sur WhatsApp.
2. **Rôles** : chacun découvre son rôle en secret. Les Ndoki se reconnaissent entre eux.
3. **Élection du Chef de quartier** : il clôture les débats et départage les égalités.
4. **Nuit** : 30 secondes d'actions en même temps, puis le chat de nuit anonyme (60, 90 ou 120 secondes).
5. **Matin** : la victime est annoncée et son rôle révélé. Le Nganga reçoit sa vision en privé.
6. **Maquis** : débat sous les vrais pseudos, 2 minutes au minimum, 6 au maximum.
7. **Vote en direct** : 60 secondes, chacun peut changer d'avis jusqu'à la fin. Le joueur chassé révèle son rôle.
8. **Fin** : chaque joueur peut ouvrir son bilan privé (rôles, votes, actions de chaque nuit, vrais noms derrière les pseudos). Il disparaît quand le dernier joueur quitte la partie.

## Rôles

| Rôle | Camp | Pouvoir |
| --- | --- | --- |
| Ndoki | Ndoki | Chaque nuit, mange un voisin avec les autres Ndoki. |
| Nganga | Village | Chaque nuit, découvre le rôle d'un joueur (une vision sur cinq est floue : le camp seulement). |
| Policier | Village | Chaque nuit, met un joueur au poste : il ne peut ni agir ni lire le chat. |
| Marabout | Village | Chaque nuit, bénit un joueur : protégé des Ndoki, du feu et de la secte. |
| Pasteur | Village | Une fois : son sermon fait recommencer le vote. La secte ne peut pas l'acheter, et s'il est visé il découvre le Gourou. |
| Gardien des byéri | Village | Une fois : protège un joueur avec le reliquaire. |
| Chasseur de brousse | Village | Quand il meurt, il tire un dernier coup de fusil. |
| Chauffeur de clando | Village | Emmène un joueur faire un tour la nuit (il n'est pas chez lui). S'il embarque un Ndoki, il se fait manger. |
| Ivrogne du maquis | Village | Croit être Nganga, Policier ou Marabout, mais ses actions ne servent à rien. Il le découvre à sa mort. |
| Habitant | Village | Aucun pouvoir. |
| Bouc émissaire | Seul | Gagne seul s'il est chassé au vote. |
| Pyromane | Seul | Arrose une maison chaque nuit, ou met le feu à toutes les maisons arrosées. Gagne s'il reste le dernier (ou seul face à un voisin). |
| Gourou des Rose-Croix | Secte | Chaque nuit, propose la richesse à un joueur. Pendant le chat de nuit, ce joueur choisit d'accepter (il devient Adepte et perd son pouvoir) ou de refuser, sans savoir qui est le Gourou. Les Ndoki, le Pyromane, le couple et le Pasteur ne peuvent que refuser ; le Pasteur découvre alors le Gourou. |
| Femme de nuit | Couple | La première nuit, choisit son mari de nuit. Ils gagnent s'ils sont les deux derniers. Si l'un meurt, l'autre meurt de chagrin. |

Les Ndoki sont fixes (environ un pour quatre joueurs : 1 jusqu'à 5, 2 dès 6, 3 dès 10, 4 dès 14, 5 dès 18). Le Nganga est toujours présent. Les autres rôles sont tirés au hasard, chacun **au plus une fois par partie**, avec plus de chances d'apparaître quand il y a plus de joueurs (5 % à 4 joueurs, 45 % à 10, 95 % à 20). Pyromane à partir de 6 joueurs, secte à partir de 7.

**Qui gagne ?** Un camp gagne quand il est le seul à avoir encore des joueurs en vie. Les Ndoki et la secte gagnent aussi quand ils sont aussi nombreux que les simples voisins, mais seulement s'il ne reste aucun autre camp dangereux.

**Ordre de la nuit :** arrestation, tour en clando, protections, choix du mari de nuit, offre de la secte, attaque des Ndoki, feu du Pyromane, puis visions.

## Lancer en local

Aucune dépendance, il faut seulement Node.js 18 ou plus récent :

```bash
node server.js
```

Puis ouvre http://localhost:3000 dans plusieurs onglets ou sur plusieurs téléphones du même réseau.

Pour tester vite, `TIME_SCALE` raccourcit tous les minuteurs (`TIME_SCALE=0.1` = 10 fois plus vite). Le script `test/simulate.js` joue des parties complètes avec des robots :

```bash
TIME_SCALE=0.02 node server.js &
node test/simulate.js 5 7   # 5 parties de 7 joueurs
# FORCE_ROLES=pyromane,gourou,femme force des rôles pour les tests
```

## Mettre en ligne

Le dépôt contient un `render.yaml` : sur Render, *New > Blueprint*, choisis ce dépôt, et c'est tout (aucune variable à remplir). Les parties vivent en mémoire : un redémarrage du serveur termine les parties en cours.

## Structure

```
server.js           serveur HTTP + WebSocket
server/game.js      règles du jeu, phases, minuteurs, vues privées de chaque joueur
server/websocket.js WebSocket écrit à la main (sans dépendance)
public/             la page du jeu (index.html, js/app.js, css/app.css, img/)
test/simulate.js    parties complètes jouées par des robots
```

Les règles détaillées sont dans le document de gameplay (v2). Les illustrations ont été générées pour le jeu.
