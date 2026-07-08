#!/bin/bash
# Creates the two scratch orgs used by the e2e tests.
# Usage: ./create_scratch.sh [dev-hub-alias]
set -e

DEV_HUB="${1:-devhub}"

sf org create scratch --definition-file config/project-scratch-def.json --alias testMigrationOrgA --target-dev-hub "$DEV_HUB" --duration-days 30
sf project deploy start --target-org testMigrationOrgA

sf org create scratch --definition-file config/project-scratch-def.json --alias testMigrationOrgB --target-dev-hub "$DEV_HUB" --duration-days 30
sf project deploy start --target-org testMigrationOrgB

# create org-default Custom_Setting_1__c in Org A
sf data create record --target-org testMigrationOrgA --sobject Custom_Setting_1__c --values "Is_Org_A__c=true"

sf org assign permset --target-org testMigrationOrgA --name "Enhanced_E"
