/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/*
 * DTrace metric for Manta zone resets
 */
var mod_ca = require('../../../../lib/ca/ca-common');

var desc = {
    module: 'mantaop',
    stat: 'zone_resets',
    fields: [ 'hostname', 'zonename', 'latency', 'errname' ],
    metad: {
	probedesc: [ {
	    probes: [ 'marlin-agent*:::zone-reset-start' ],
	    gather: {
		latency: {
			gather: 'timestamp',
			store: 'global[pid,copyinstr(arg0)]'
		}
	    }
	}, {
	    probes: [ 'marlin-agent*:::zone-reset-done' ],
	    verify: {
		latency: '$0[pid,copyinstr(arg0)]'
	    },
	    transforms: {
		hostname: '"' + mod_ca.caSysinfo().ca_hostname + '"',
		zonename: 'copyinstr(arg0)',
		errname: 'copyinstr(arg1)',
		latency: 'timestamp - $0[pid,copyinstr(arg0)]'
	    },
	    aggregate: {
		default: 'count()',
		hostname: 'count()',
		zonename: 'count()',
		errname: 'count()',
		latency: 'llquantize($0, 10, 3, 11, 100)'
	    }
	}, {
	    probes: [ 'marlin-supervisor*:::zone-reset-done' ],
	    clean: {
		latency: '$0[pid,copyinstr(arg0)]'
	    }
	} ]
    }
};

exports.cadMetricDesc = desc;
