// Test de la broche de l'ESP32 utilisee pour la sonde : dit si l'ESP32
// arrive a tirer la ligne a 0 V. La sonde n'est pas necessaire, mais la
// resistance de 4,7 kOhm doit rester entre 3V3 et la broche testee.
// Moniteur serie a 115200 bauds.
#include <OneWire.h>
#include <util/OneWire_direct_gpio.h>

const uint8_t BROCHE = 15;  // 15 si le fil jaune est sur D15, 4 s'il est sur D4

OneWire ow(BROCHE);  // configure la broche exactement comme le firmware
IO_REG_TYPE masque = PIN_TO_BITMASK(BROCHE);
volatile IO_REG_TYPE *base = PIN_TO_BASEREG(BROCHE);

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.printf("\n=== Test de la broche GPIO%u ===\n", BROCHE);

  pinMode(BROCHE, INPUT);
  delay(5);
  Serial.printf("1. Au repos                        : %s\n",
                digitalRead(BROCHE) ? "HAUTE -> OK" : "BASSE -> ECHEC (resistance ?)");

  pinMode(BROCHE, OUTPUT);
  digitalWrite(BROCHE, LOW);
  delayMicroseconds(50);
  bool bas1 = !digitalRead(BROCHE);
  pinMode(BROCHE, INPUT);
  Serial.printf("2. Forcee a 0 V (digitalWrite)     : %s\n",
                bas1 ? "BASSE -> OK" : "HAUTE -> ECHEC : la broche ne tire pas");

  DIRECT_WRITE_LOW(base, masque);
  DIRECT_MODE_OUTPUT(base, masque);
  delayMicroseconds(50);
  bool bas2 = !DIRECT_READ(base, masque);
  DIRECT_MODE_INPUT(base, masque);
  delayMicroseconds(70);
  bool remonte = DIRECT_READ(base, masque);
  Serial.printf("3. Forcee a 0 V (methode OneWire)  : %s\n",
                bas2 ? "BASSE -> OK" : "HAUTE -> ECHEC : la bibliotheque ne pilote pas la broche");
  Serial.printf("4. Remontee apres relachement      : %s\n",
                remonte ? "HAUTE -> OK" : "BASSE -> ECHEC");
  Serial.printf("5. Reponse d'une sonde             : %s\n\n",
                ow.reset() ? "OUI" : "NON");
}

// Ensuite, en boucle : 4 s a 0 V puis 4 s relachee, pour le multimetre.
void loop() {
  Serial.println("Ligne FORCEE A 0 V   -> le multimetre doit lire environ 0 V");
  DIRECT_WRITE_LOW(base, masque);
  DIRECT_MODE_OUTPUT(base, masque);
  delay(4000);
  DIRECT_MODE_INPUT(base, masque);
  Serial.println("Ligne RELACHEE       -> le multimetre doit lire environ 3,3 V");
  delay(4000);
}
