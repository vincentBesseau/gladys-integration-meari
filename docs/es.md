# Meari

**Meari** es la plataforma en la nube detrás de muchas marcas de cámaras y timbres Wi-Fi, a menudo con batería. Si su cámara se controla con una de estas aplicaciones, esta integración es para usted:

| Aplicación            | Marcas habituales                   |
| --------------------- | ----------------------------------- |
| ieGeek Cam            | ieGeek                              |
| CloudEdge             | cámaras vendidas bajo muchas marcas |
| CloudPlus / CloudHome | ídem                                |
| ANRAN                 | ANRAN                               |
| Arenti                | Arenti                              |
| BoifunCam             | Boifun                              |

Estas cámaras no exponen ni RTSP ni ONVIF: la integración pasa por la nube Meari, como la aplicación.

## Qué obtiene

Para cada cámara:

- **Movimiento**: activo durante la duración elegida tras la última alerta (movimiento, PIR o persona).
- **Timbre** (solo timbres): pasa a 1 durante unos segundos en cada pulsación.
- **Batería** y **carga**, leídas de la nube sin despertar la cámara.
- **Imagen**: la foto de la última alerta, mostrada en el widget de cámara.
- **Ajustes** cuando la cámara los expone: detección de movimiento, detección de personas, sensor PIR, LED de estado.

Dos desencadenantes de escena: **Timbre pulsado** y **Movimiento detectado** (filtrable por persona u otro movimiento).

## Widgets del panel

- **Cámara Meari**: la última imagen, la batería y el movimiento. Un timbre con batería duerme entre eventos, por lo que la imagen se actualiza en cada alerta o pulsación (el widget se actualiza al instante), sin despertar nunca la cámara. El botón «Buscar una imagen nueva» consulta la nube por si hay una más reciente.
- **Pulsaciones del timbre**: las últimas 5 pulsaciones, con el día y la hora, y la imagen tomada al pulsar cuando la nube la proporciona. El historial lo conserva la integración y se reconstruye desde la nube (últimos 7 días) al iniciar.

En el widget **Cámara Meari**, elija una cámara — los timbres se excluyen, tienen su propio widget. En **Pulsaciones del timbre**, elija un timbre (por defecto: todos); pulse una entrada para abrir su imagen en grande.

## Configuración

1. **Cree una segunda cuenta en su aplicación** (ieGeek Cam, CloudEdge…) y comparta sus cámaras con ella. La nube solo admite una sesión en tiempo real por cuenta: con la cuenta del teléfono las alertas siguen llegando, pero por sondeo (en menos de 15 segundos) en lugar de al instante.
2. En Gladys, abra la integración e indique el correo, la contraseña, la aplicación usada (aquella con la que se creó la cuenta), el código de país y el prefijo telefónico.
3. Haga clic en **Probar la conexión**: se listan sus cámaras.
4. Pestaña **Descubrimiento**: añada sus cámaras.

## Límites conocidos

- Sin vídeo en directo: la imagen es la de la última alerta.
- El retraso entre una pulsación y la escena depende de la nube (normalmente de uno a unos pocos segundos con push).
- Si su timbre no se reconoce como tal, active «Añadir una función de timbre a todas las cámaras».

Integración no oficial, sin relación con Meari ni con los editores de las aplicaciones.
