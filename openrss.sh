#!/usr/bin/env bash

# To use an OpenStack cloud you need to authenticate against the Identity
# service named keystone, which returns a **Token** and **Service Catalog**.
# The catalog contains the endpoints for all services the user/tenant has
# access to - such as Compute, Image Service, Identity, Object Storage, Block
# Storage, and Networking (code-named nova, glance, keystone, swift,
# cinder, and neutron).
#
# *NOTE*: Using the 3 *Identity API* does not necessarily mean any other
# OpenStack API is version 3. For example, your cloud provider may implement
# Image API v1.1, Block Storage API v2, and Compute API v2.0. OS_AUTH_URL is
# only for the Identity API served through keystone.
export OS_AUTH_URL=http://94.232.171.61:5000
export OS_INTERFACE=public
export OS_IDENTITY_API_VERSION=3

# With the addition of Keystone we have standardized on the term **project**
# as the entity that owns the resources.
export OS_PROJECT_ID=0098ed7d85d04a298a79cc9a1ae30947
export OS_PROJECT_NAME="Account #2639"
export OS_USER_DOMAIN_NAME="Default"
export OS_PROJECT_DOMAIN_ID="default"

# unset v2.0 items in case set
unset OS_TENANT_ID
unset OS_TENANT_NAME

# In addition to the owning entity (tenant), OpenStack stores the entity
# performing the action as the **user**.
export OS_USERNAME="hb_client_3199_3"

# With Keystone you pass the keystone password.
export OS_PASSWORD="ivbrLrp1"
    
