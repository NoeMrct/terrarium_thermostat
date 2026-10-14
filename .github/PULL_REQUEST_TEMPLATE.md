## Ce que change cette proposition

<!-- Une phrase sur le pourquoi, puis le quoi. -->

## Vérifications

- [ ] `make -C sim test` passe (bancs C++)
- [ ] `npm test` passe dans `outils/` (démonstration, page embarquée, aide, page compressée, budget, lint, types)
- [ ] `app/demo.html`, `app/aide.html` et `page_web_gz.h` ont été régénérés s'ils devaient l'être
- [ ] `CHANGELOG.md` (section *Non publié*) mentionne le changement s'il est visible par l'utilisateur
- [ ] `FW_VERSION` et `PROTO_VERSION` ont été incrémentés si le firmware ou le protocole changent de contrat
