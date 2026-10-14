SHELL := /bin/bash
# Bancs d'essai des modules sans dépendance Arduino, compilés pour le PC.
# Seule dépendance tierce : ArduinoJson (en-têtes seuls), pour le canal de
# commande — récupérée automatiquement dans tiers/ à la version du firmware.
#
#   make            compile tous les bancs
#   make test       compile et lance tout
#   make regulation lance seulement les scenarios de regulation
#   make anneau     lance seulement l'anneau d'historique
#   make format     lance seulement l'echappement JSON et les horaires
#   make qr         lance seulement l'encodeur QR de l'ecran d'appairage
#   make protocole  lance seulement le canal de commande (vrai code du firmware)
#   make migration  relecture d'une memoire NVS ecrite par un firmware plus ancien
#   make csv N=2    trace detaillee du scenario N de la regulation dans run.csv
#   make sanitize   rejoue tout sous AddressSanitizer et UndefinedBehaviorSanitizer
#   make fuzz       libFuzzer (clang) sur format, anneau, QR, protocole et régulation
#   make couverture lignes couvertes par les bancs (gcov), echoue sous SEUIL_COUVERTURE %
#   make tidy       clang-tidy sur les modules compilables ici

CXX      ?= g++
CXXFLAGS ?= -std=c++11 -O2 -Wall -Wextra
SANFLAGS  = -std=c++11 -O1 -Wall -Wextra -fsanitize=address,undefined -fno-omit-frame-pointer
N        ?= 1
DUREE    ?= 60
CLANGXX  ?= clang++
SEUIL_COUVERTURE ?= 80

# ArduinoJson pour le PC : même version que outils/bibliotheques.txt.
ARDUINOJSON_VERSION = 7.4.2
ARDUINOJSON_INC ?= tiers/arduinojson/src
INC = -I.. -I$(ARDUINOJSON_INC)

BANCS = simulateur test-anneau test-format test-qr test-protocole test-migration
SRC_PROTOCOLE = ../protocole.cpp ../format.cpp ../controle.cpp ../reglages.cpp

all: $(BANCS)

$(ARDUINOJSON_INC)/ArduinoJson.h:
	mkdir -p tiers
	git clone --quiet --depth 1 --branch v$(ARDUINOJSON_VERSION) https://github.com/bblanchon/ArduinoJson tiers/arduinojson

simulateur: simulateur.cpp ../controle.cpp ../controle.h
	$(CXX) $(CXXFLAGS) -o $@ simulateur.cpp ../controle.cpp -lm

test-anneau: test-anneau.cpp ../anneau.cpp ../anneau.h
	$(CXX) $(CXXFLAGS) -o $@ test-anneau.cpp ../anneau.cpp

test-format: test-format.cpp ../format.cpp ../format.h
	$(CXX) $(CXXFLAGS) -o $@ test-format.cpp ../format.cpp

test-qr: test-qr.cpp ../qr.cpp ../qr.h
	$(CXX) $(CXXFLAGS) -o $@ test-qr.cpp ../qr.cpp

test-protocole: test-protocole.cpp socle-factice.h $(SRC_PROTOCOLE) ../protocole.h ../reglages.h $(ARDUINOJSON_INC)/ArduinoJson.h
	$(CXX) $(CXXFLAGS) $(INC) -o $@ test-protocole.cpp $(SRC_PROTOCOLE) -lm

test-migration: test-migration.cpp ../reglages.cpp ../reglages.h ../controle.cpp
	$(CXX) $(CXXFLAGS) $(INC) -o $@ test-migration.cpp ../reglages.cpp ../controle.cpp -lm

test: regulation anneau format qr protocole migration

regulation: simulateur
	./simulateur

anneau: test-anneau
	./test-anneau

format: test-format
	./test-format

qr: test-qr
	./test-qr

protocole: test-protocole
	./test-protocole

migration: test-migration
	./test-migration

sanitize: $(ARDUINOJSON_INC)/ArduinoJson.h
	$(CXX) $(SANFLAGS) -o san_simulateur simulateur.cpp ../controle.cpp -lm && ./san_simulateur
	$(CXX) $(SANFLAGS) -o san_anneau     test-anneau.cpp ../anneau.cpp     && ./san_anneau
	$(CXX) $(SANFLAGS) -o san_format     test-format.cpp ../format.cpp     && ./san_format
	$(CXX) $(SANFLAGS) -o san_qr         test-qr.cpp ../qr.cpp             && ./san_qr
	$(CXX) $(SANFLAGS) $(INC) -o san_protocole test-protocole.cpp $(SRC_PROTOCOLE) -lm && ./san_protocole
	$(CXX) $(SANFLAGS) $(INC) -o san_migration test-migration.cpp ../reglages.cpp ../controle.cpp -lm && ./san_migration

# Fuzzing : clang et sa bibliothèque libFuzzer (paquet libclang-rt-<n>-dev).
# Le corpus de départ est engendré par le harnais lui-même ; -max_len borne la
# taille des entrées, ce qui suffit à ces analyseurs de petites chaînes.
fuzz: fuzz.cpp socle-factice.h ../format.cpp ../anneau.cpp ../qr.cpp ../controle.cpp ../protocole.cpp ../reglages.cpp $(ARDUINOJSON_INC)/ArduinoJson.h
	$(CLANGXX) -std=c++11 -O1 -g -fsanitize=fuzzer,address,undefined -fno-omit-frame-pointer $(INC) \
	  -o fuzz fuzz.cpp ../format.cpp ../anneau.cpp ../qr.cpp ../controle.cpp ../protocole.cpp ../reglages.cpp -lm
	mkdir -p corpus && ./fuzz corpus -max_total_time=$(DUREE) -max_len=600 -print_final_stats=1

# Couverture de lignes des modules du firmware par les bancs (gcov). Chaque
# module est compilé une fois en objet instrumenté, lié dans tous les bancs qui
# l'utilisent : les exécutions s'additionnent dans un seul compteur par fichier.
# Le seuil porte sur chaque fichier du firmware, pas sur les bancs eux-mêmes.
MODULES = controle anneau format qr protocole reglages
COVFLAGS = -std=c++11 -O0 --coverage $(INC)
couverture: $(ARDUINOJSON_INC)/ArduinoJson.h
	rm -rf couverture && mkdir -p couverture
	for m in $(MODULES); do $(CXX) $(COVFLAGS) -c ../$$m.cpp -o couverture/$$m.o || exit 1; done
	$(CXX) $(COVFLAGS) -o couverture/simulateur simulateur.cpp couverture/controle.o -lm && ./couverture/simulateur > /dev/null
	$(CXX) $(COVFLAGS) -o couverture/anneau test-anneau.cpp couverture/anneau.o && ./couverture/anneau > /dev/null
	$(CXX) $(COVFLAGS) -o couverture/format test-format.cpp couverture/format.o && ./couverture/format > /dev/null
	$(CXX) $(COVFLAGS) -o couverture/qr test-qr.cpp couverture/qr.o && ./couverture/qr > /dev/null
	$(CXX) $(COVFLAGS) -o couverture/protocole test-protocole.cpp couverture/protocole.o couverture/format.o couverture/controle.o couverture/reglages.o -lm && ./couverture/protocole > /dev/null
	$(CXX) $(COVFLAGS) -o couverture/migration test-migration.cpp couverture/reglages.o couverture/controle.o -lm && ./couverture/migration > /dev/null
	cd couverture && for m in $(MODULES); do gcov -o . ../../$$m.cpp > /dev/null 2>&1; done; \
	  for m in $(MODULES); do \
	    p=$$(grep -h "Lines executed" <(gcov -n -o . ../../$$m.cpp 2>/dev/null | grep -A1 "File '.*/$$m.cpp'") | sed 's/.*executed://;s/%.*//'); \
	    echo "$$m $$p"; \
	  done > resume.txt; \
	  awk -v seuil=$(SEUIL_COUVERTURE) '{ ok = ($$2+0 >= seuil); printf("   %-7s %-12s %6.2f %%\n", ok ? "[ OK ]" : "[ECHEC]", $$1 ".cpp", $$2); if (!ok) echec = 1 } END { exit echec }' resume.txt
	@echo "=== COUVERTURE : chaque module du firmware au-dessus de $(SEUIL_COUVERTURE) % ==="

# clang-tidy sur ce qui se compile ici (les modules Arduino ne le peuvent pas).
tidy: $(ARDUINOJSON_INC)/ArduinoJson.h
	clang-tidy --quiet -checks='-*,bugprone-*,clang-analyzer-*,performance-*,-bugprone-easily-swappable-parameters,-bugprone-narrowing-conversions,-bugprone-implicit-widening-of-multiplication-result,-bugprone-branch-clone,-bugprone-signed-char-misuse,-clang-analyzer-security.insecureAPI.DeprecatedOrUnsafeBufferHandling' \
	  -warnings-as-errors='*' -header-filter='.*/(controle|anneau|format|qr|protocole|reglages)\.h' \
	  ../controle.cpp ../anneau.cpp ../format.cpp ../qr.cpp ../protocole.cpp ../reglages.cpp -- -std=c++11 $(INC)

csv: simulateur
	./simulateur --csv $(N) > run.csv
	@echo "Trace ecrite dans run.csv (colonnes : t_s, temperature, consigne, demande, charge, tapis)"

clean:
	rm -rf $(BANCS) san_simulateur san_anneau san_format san_qr san_protocole san_migration fuzz corpus crash-* run.csv couverture

.PHONY: all test regulation anneau format qr protocole migration sanitize fuzz couverture tidy csv clean
