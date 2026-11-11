// Test du bus 1-Wire sur D4 : n'utilise que la bibliotheque OneWire,
// rien du firmware. Moniteur serie a 115200 bauds.
#include <OneWire.h>

const uint8_t BROCHE = 4;  // D4
OneWire ow(BROCHE);

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println("\n=== Test 1-Wire sur D4 ===");
}

void loop() {
  pinMode(BROCHE, INPUT);
  delay(5);
  Serial.printf("Ligne au repos : %s\n", digitalRead(BROCHE) ? "HAUTE (normal)" : "BASSE (anormal)");
  Serial.printf("Presence       : %s\n", ow.reset() ? "OUI, une sonde repond" : "NON, aucune sonde ne repond");

  uint8_t adr[8];
  int n = 0;
  ow.reset_search();
  while (ow.search(adr)) {
    n++;
    Serial.print("Sonde trouvee  :");
    for (int i = 0; i < 8; i++) Serial.printf(" %02X", adr[i]);
    Serial.println(OneWire::crc8(adr, 7) == adr[7] ? "  (CRC bon)" : "  (CRC faux)");
    ow.reset(); ow.select(adr); ow.write(0x44, 1);  // lance une mesure
    delay(800);
    ow.reset(); ow.select(adr); ow.write(0xBE);     // lit le resultat
    uint8_t d[9];
    for (int i = 0; i < 9; i++) d[i] = ow.read();
    Serial.printf("Temperature    : %.2f C\n", (int16_t)((d[1] << 8) | d[0]) / 16.0);
  }
  Serial.printf("Total          : %d sonde(s)\n\n", n);
  delay(3000);
}
