# ieGeek Cam

Cette intégration ajoute à Gladys les caméras et sonnettes **ieGeek** sur batterie (application *ieGeek Cam*), et plus largement les appareils de la plateforme Meari (CloudEdge, CloudPlus, ANRAN, BoifunCam, Arenti).

Ces caméras n'exposent ni RTSP ni ONVIF : l'intégration passe par le cloud du fabricant, comme l'application.

## Ce que vous obtenez

Pour chaque caméra :

- **Mouvement** : capteur actif pendant la durée choisie après la dernière alerte (mouvement, PIR ou personne).
- **Sonnette** (sonnettes uniquement) : passe à 1 pendant quelques secondes à chaque appui.
- **Batterie** et **charge en cours**, lues dans le cloud sans réveiller la caméra.
- **Image** : la photo de la dernière alerte, affichée dans le widget caméra.
- **Réglages** quand la caméra les expose : détection de mouvement, détection de personne, capteur PIR, LED d'état.

Deux déclencheurs de scène : **Appui sur la sonnette** et **Mouvement détecté** (filtrable par personne ou autre mouvement).

## Configuration

1. **Créez un deuxième compte ieGeek Cam** et partagez-lui vos caméras depuis l'application. Le cloud n'accepte qu'une session temps réel par compte : avec le compte du téléphone, les alertes arrivent quand même, mais par interrogation (sous 15 secondes) au lieu d'être instantanées.
2. Dans Gladys, ouvrez l'intégration et renseignez l'e-mail, le mot de passe, l'application utilisée (ieGeek Cam par défaut), le code pays et l'indicatif.
3. Cliquez sur **Tester la connexion** : la liste de vos caméras s'affiche.
4. Onglet **Découverte** : ajoutez vos caméras.

## Limites connues

- Pas de flux vidéo en direct : l'image est celle de la dernière alerte.
- Le délai entre l'appui et la scène dépend du cloud (en général une à quelques secondes en push).
- Si votre sonnette n'est pas reconnue comme telle, activez « Ajouter une fonction sonnette à toutes les caméras ».

Intégration non officielle, sans lien avec ieGeek ni Meari.
