# Meari

**Meari** est la plateforme cloud utilisée par de nombreuses marques de caméras et sonnettes Wi-Fi, souvent sur batterie. Si votre caméra se pilote avec l'une de ces applications, cette intégration est faite pour vous :

| Application           | Marques courantes                          |
| --------------------- | ------------------------------------------ |
| ieGeek Cam            | ieGeek                                     |
| CloudEdge             | caméras vendues sous de nombreuses marques |
| CloudPlus / CloudHome | idem                                       |
| ANRAN                 | ANRAN                                      |
| Arenti                | Arenti                                     |
| BoifunCam             | Boifun                                     |

Ces caméras n'exposent ni RTSP ni ONVIF : l'intégration passe par le cloud Meari, comme l'application.

## Ce que vous obtenez

Pour chaque caméra :

- **Mouvement** : capteur actif pendant la durée choisie après la dernière alerte (mouvement, PIR ou personne).
- **Sonnette** (sonnettes uniquement) : passe à 1 pendant quelques secondes à chaque appui.
- **Batterie** et **charge en cours**, lues dans le cloud sans réveiller la caméra.
- **Image** : la photo de la dernière alerte, affichée dans le widget caméra.
- **Réglages** quand la caméra les expose : détection de mouvement, détection de personne, capteur PIR, LED d'état.

Deux déclencheurs de scène : **Appui sur la sonnette** et **Mouvement détecté** (filtrable par personne ou autre mouvement).

## Widgets du tableau de bord

- **Caméra Meari** : la dernière image, la batterie et le mouvement. Une sonnette sur batterie dort entre deux événements : l'image est donc mise à jour à chaque alerte ou appui (le widget se rafraîchit aussitôt), sans jamais réveiller la caméra. Le bouton « Chercher une image » va voir dans le cloud s'il existe une image plus récente.
- **Appuis sonnette** : les 5 derniers appuis, avec le jour et l'heure, et l'image prise au moment de l'appui quand le cloud en fournit une. L'historique est conservé par l'intégration et reconstruit depuis le cloud (7 derniers jours) au démarrage.

Dans le widget **Caméra Meari**, choisissez une caméra — les sonnettes sont exclues, elles ont leur propre widget. Dans **Appuis sonnette**, choisissez une sonnette (par défaut : toutes) ; appuyez sur un appui pour ouvrir son image en grand.

## Configuration

1. **Créez un deuxième compte dans votre application** (ieGeek Cam, CloudEdge…) et partagez-lui vos caméras. Le cloud n'accepte qu'une session temps réel par compte : avec le compte du téléphone, les alertes arrivent quand même, mais par interrogation (sous 15 secondes) au lieu d'être instantanées.
2. Dans Gladys, ouvrez l'intégration et renseignez l'e-mail, le mot de passe, l'application utilisée (celle avec laquelle le compte a été créé), le code pays et l'indicatif.
3. Cliquez sur **Tester la connexion** : la liste de vos caméras s'affiche.
4. Onglet **Découverte** : ajoutez vos caméras.

## Limites connues

- Pas de flux vidéo en direct : l'image est celle de la dernière alerte.
- Le délai entre l'appui et la scène dépend du cloud (en général une à quelques secondes en push).
- Si votre sonnette n'est pas reconnue comme telle, activez « Ajouter une fonction sonnette à toutes les caméras ».

Intégration non officielle, sans lien avec Meari ni les éditeurs des applications.
