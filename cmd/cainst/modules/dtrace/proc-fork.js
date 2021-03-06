/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/*
 * DTrace metric to watch process forks
 */

var mod_ca = require('../../../../lib/ca/ca-common');

var desc = {
    module: 'unix',
    stat: 'proc_forks',
    fields: [ 'hostname', 'zonename', 'execname', 'subsecond', 'psargs',
	'ppid', 'pid' ],
    metad: {
	probedesc: [
	    {
		probes: [ 'proc:::create' ],
		aggregate: {
		    default: 'count()',
		    hostname: 'count()',
		    zonename: 'count()',
		    execname: 'count()',
		    subsecond: 'lquantize(($0 % 1000000000) / 1000000, ' +
		        '0, 1000, 10)',
		    psargs: 'count()',
		    ppid: 'count()',
		    pid: 'count()'
		},
		transforms: {
		    hostname: '"' + mod_ca.caSysinfo().ca_hostname + '"',
		    zonename: 'zonename',
		    execname: 'execname',
		    subsecond: 'timestamp',
		    psargs: 'curpsinfo->pr_psargs',
		    ppid: 'lltostr(ppid, 10)',
		    pid: 'lltostr(pid, 10)'
		}
	    }
	]
    }
};

exports.cadMetricDesc = desc;
