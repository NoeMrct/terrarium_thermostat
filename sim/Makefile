# Bancs d'essai des modules sans dépendance Arduino, compilés pour le PC.
# Aucune dépendance : ni Arduino, ni bibliothèque tierce.
#
#   make            compile les trois bancs
#   make test       compile et lance tout
#   make regulation lance seulement les scenarios de regulation
#   make anneau     lance seulement l'anneau d'historique
#   make format     lance seulement l'echappement JSON et les horaires
#   make csv N=2    trace detaillee du scenario N de la regulation dans run.csv
#   make sanitize   rejoue tout sous AddressSanitizer et UndefinedBehaviorSanitizer

CXX      ?= g++
CXXFLAGS ?= -std=c++11 -O2 -Wall -Wextra
SANFLAGS  = -std=c++11 -O1 -Wall -Wextra -fsanitize=address,undefined -fno-omit-frame-pointer
N        ?= 1

BANCS = simulateur test-anneau test-format

all: $(BANCS)

simulateur: simulateur.cpp ../controle.cpp ../controle.h
	$(CXX) $(CXXFLAGS) -o $@ simulateur.cpp ../controle.cpp -lm

test-anneau: test-anneau.cpp ../anneau.cpp ../anneau.h
	$(CXX) $(CXXFLAGS) -o $@ test-anneau.cpp ../anneau.cpp

test-format: test-format.cpp ../format.cpp ../format.h
	$(CXX) $(CXXFLAGS) -o $@ test-format.cpp ../format.cpp

test: regulation anneau format

regulation: simulateur
	./simulateur

anneau: test-anneau
	./test-anneau

format: test-format
	./test-format

sanitize:
	$(CXX) $(SANFLAGS) -o san_simulateur simulateur.cpp ../controle.cpp -lm && ./san_simulateur
	$(CXX) $(SANFLAGS) -o san_anneau     test-anneau.cpp ../anneau.cpp     && ./san_anneau
	$(CXX) $(SANFLAGS) -o san_format     test-format.cpp ../format.cpp     && ./san_format

csv: simulateur
	./simulateur --csv $(N) > run.csv
	@echo "Trace ecrite dans run.csv (colonnes : t_s, temperature, consigne, demande, charge, tapis)"

clean:
	rm -f $(BANCS) san_simulateur san_anneau san_format run.csv

.PHONY: all test regulation anneau format sanitize csv clean
