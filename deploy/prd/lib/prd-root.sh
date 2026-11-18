#!/usr/bin/env bash
# The ONE trusted production configuration root (app.env, compose.env,
# release.env, backup.key, staging-env.path). deploy.sh and dc read it from
# here and refuse a PRD_CONF_DIR environment variable that names anything
# else: an environment variable must never redirect the production trust root.
#
# Changing it is a reviewed code change. The offline test
# (deploy/prd/test-secret-reuse.sh) replaces this file inside its throwaway
# sandbox copy - the same way it replaces ./dc with a stub - and asserts that
# the copy in the repository still names /etc/mas-sular-prd.
PRD_TRUSTED_CONF_DIR=/etc/mas-sular-prd
