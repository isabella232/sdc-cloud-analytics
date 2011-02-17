/*
 * caconfigsvc: Cloud Analytics Configuration Service
 *
 * This service is responsible for directing other components of the cloud
 * analytics service, including instrumenters and aggregators.
 */

var mod_http = require('http');
var mod_sys = require('sys');
var ASSERT = require('assert');

var mod_ca = require('../lib/ca/ca-common');
var mod_caamqp = require('../lib/ca/ca-amqp');
var mod_cainst = require('../lib/ca/ca-inst');
var mod_cap = require('../lib/ca/ca-amqp-cap');
var mod_cahttp = require('../lib/ca/ca-http');
var mod_log = require('../lib/ca/ca-log');
var mod_mapi = require('../lib/ca/ca-mapi');
var HTTP = require('../lib/ca/http-constants');

var cfg_http;			/* http server */
var cfg_amqp;			/* AMQP handle */
var cfg_cap;			/* camqp CAP wrapper */
var cfg_log;			/* log handle */
var cfg_factory;		/* instrumentation factory */
var cfg_mapi;			/* mapi config */
var cfg_broker;			/* AMQP broker config */
var cfg_sysinfo;		/* system config */

var cfg_name = 'configsvc';			/* component name */
var cfg_vers = '0.0';				/* component version */
var cfg_http_port = mod_ca.ca_http_port_config;	/* HTTP port for API endpoint */
var cfg_http_baseuri = '/ca';			/* base of HTTP API */

var cfg_start;			/* start time */
var cfg_aggregators = {};	/* all aggregators, by hostname */
var cfg_transformations = {};	/* all transformations, by name */
var cfg_instrumenters = {};	/* all instrumenters, by hostname */
var cfg_statmods = {};		/* describes available metrics and which */
				/* instrumenters provide them. */

/*
 * The following constants and data structures manage active instrumentations.
 * Each instrumentation is either global or associated with a particular
 * customer.  For internal use, each instrumentation has a qualified identifier
 * with one of the following forms:
 *
 *	global;<instid>			For global instrumentations
 *	cust:<custid>;<instid>		For per-customer instrumentations
 *
 * In both of these forms, <instid> is a positive integer.  These qualified
 * identifiers are only used by this implementation; they are not exposed
 * through any public interface.
 *
 * All instrumentation objects are stored in cfg_insts indexed by this fully
 * qualified identifier.  Additionally, the set of per-customer instrumentations
 * is stored in cfg_customers[customer_id]['instrumentations'], and the set of
 * global instrumentations is stored in cfg_global_insts.
 */
var cfg_insts = {};		/* all instrumentations, by inst id */
var cfg_customers = {};		/* all customers, by cust id */
var cfg_global_insts = {};	/* global (non-customer) insts */

function main()
{
	var mapi;

	cfg_start = new Date().getTime();
	cfg_sysinfo = mod_ca.caSysinfo(cfg_name, cfg_vers);
	cfg_log = new mod_log.caLog({ out: process.stdout });
	cfg_broker = mod_ca.caBroker();
	cfg_mapi = mod_ca.caMapiConfig();

	cfg_amqp = new mod_caamqp.caAmqp({
	    broker: cfg_broker,
	    exchange: mod_ca.ca_amqp_exchange,
	    exchange_opts: mod_ca.ca_amqp_exchange_opts,
	    basename: mod_ca.ca_amqp_key_base_config,
	    hostname: cfg_sysinfo.ca_hostname,
	    bindings: [ mod_ca.ca_amqp_key_config, mod_ca.ca_amqp_key_all ]
	});
	cfg_amqp.on('amqp-error', mod_caamqp.caAmqpLogError(cfg_log));
	cfg_amqp.on('amqp-fatal', mod_caamqp.caAmqpFatalError(cfg_log));

	cfg_cap = new mod_cap.capAmqpCap({
	    amqp: cfg_amqp,
	    log: cfg_log,
	    sysinfo: cfg_sysinfo
	});
	cfg_cap.on('msg-cmd-ping', cfgCmdPing);
	cfg_cap.on('msg-cmd-status', cfgCmdStatus);
	cfg_cap.on('msg-notify-aggregator_online', cfgNotifyAggregatorOnline);
	cfg_cap.on('msg-notify-configsvc_online', mod_ca.caNoop);
	cfg_cap.on('msg-notify-instrumenter_online',
	    cfgNotifyInstrumenterOnline);
	cfg_cap.on('msg-notify-log', cfgNotifyLog);
	cfg_cap.on('msg-notify-instrumenter_error', cfgNotifyInstrumenterError);

	cfg_http = new mod_cahttp.caHttpServer({
	    log: cfg_log,
	    port: cfg_http_port,
	    router: cfgHttpRouter
	});

	cfg_log.info('Config service starting up (%s/%s)', cfg_name, cfg_vers);
	cfg_log.info('%-12s %s', 'Hostname:', cfg_sysinfo.ca_hostname);
	cfg_log.info('%-12s %s', 'AMQP broker:', JSON.stringify(cfg_broker));
	cfg_log.info('%-12s %s', 'Routing key:', cfg_amqp.routekey());
	cfg_log.info('%-12s Port %d', 'HTTP server:', cfg_http_port);

	if (cfg_mapi) {
		cfg_log.info('%-12s %s:%s', 'MAPI host:', cfg_mapi.host,
		    cfg_mapi.port);
		mapi = new mod_mapi.caMapi(cfg_mapi);
	} else {
		cfg_log.warn('MAPI_HOST, MAPI_PORT, MAPI_USER, or ' +
		    'MAPI_PASSWORD not set.  Per-customer use disabled.');
	}

	cfg_factory = new mod_cainst.caInstrumentationFactory({
	    cap: cfg_cap,
	    log: cfg_log,
	    modules: cfg_statmods,
	    transformations: cfg_transformations,
	    aggregators: cfg_aggregators,
	    instrumenters: cfg_instrumenters,
	    uri_base: cfg_http_baseuri,
	    mapi: mapi
	});

	cfg_amqp.start(function () {
		cfg_log.info('AMQP broker connected.');

		cfg_http.start(function () {
			cfg_log.info('HTTP server started.');
			cfgStarted();
		});
	});
}

function cfgStarted()
{
	cfg_cap.sendNotifyCfgOnline(mod_ca.ca_amqp_key_all);
}

/*
 * Defines the available HTTP URIs.  See the Public HTTP API doc for details.
 */
function cfgHttpRouter(server)
{
	var metrics = '/metrics';
	var transforms = '/transformations';
	var instrumentations = '/instrumentations';
	var instrumentations_id = instrumentations + '/:instid';
	var infixes = [ '', '/customers/:custid' ];
	var ii, base;

	server.get(cfg_http_baseuri + '/admin/status', cfgHttpAdminStatus);

	for (ii = 0; ii < infixes.length; ii++) {
		base = cfg_http_baseuri + infixes[ii];
		server.get(base + metrics, cfgHttpMetricsList);
		server.get(base + transforms, cfgHttpTransformsList);
		server.get(base + instrumentations,
		    cfgHttpInstrumentationsList);
		server.post(base + instrumentations, cfgHttpInstCreate);
		server.del(base + instrumentations_id, cfgHttpInstDelete);
		server.get(base + instrumentations_id,
		    cfgHttpInstGetProperties);
		server.put(base + instrumentations_id,
		    cfgHttpInstSetProperties);
		server.get(base + instrumentations_id + '/value',
		    cfgHttpInstValue);
		server.get(base + instrumentations_id + '/value/*',
		    cfgHttpInstValue);
	}
}

/*
 * Given a customer identifier, return the set of instrumentations.  If custid
 * is undefined, returns the set of global instrumentations.  This function
 * always returns a valid object even if we've never seen this customer before.
 */
function cfgInstrumentations(custid)
{
	if (custid === undefined)
		return (cfg_global_insts);

	if (!(custid in cfg_customers))
		cfg_customers[custid] = {};

	return (cfg_customers[custid]);
}

/*
 * Retrieves an object describing the current service state for debugging and
 * monitoring.  Values include configuration constants (like remote service
 * hostnames), tunables, internal state counters, etc.  The following arguments
 * must be specified:
 *
 *	callback	Invoked upon completion with one argument representing
 *			the current status.  The callback may be invoked
 *			synchronously if "recurse" is false.
 *
 *	recurse		Send AMQP status messages to other components in the
 *			system (instrumenters and aggregators) to retrieve their
 *			status as well.  If any of these commands fail or
 *			time out, the corresponding entries will contain an
 *			'error' describing what happened.
 *
 *	timeout		When recurse is true, this number denotes the maximum
 *			time to wait (in milliseconds) for any the status
 *			requests to other components before timing out.
 */
function cfgAdminStatus(callback, recurse, timeout)
{
	var ret, key, obj;
	var nrequests, checkdone, doamqp;
	var start = new Date().getTime();

	checkdone = function () {
		ASSERT.ok(nrequests > 0);
		if (--nrequests !== 0)
			return;

		ret['request_latency'] = new Date().getTime() - start;
		callback(ret);
	};

	nrequests = 1;
	ret = {};
	ret['amqp_broker'] = cfg_broker;
	ret['amqp_routekey'] = cfg_amqp.routekey();
	ret['heap'] = process.memoryUsage();
	ret['http'] = cfg_http.info();
	ret['sysinfo'] = cfg_sysinfo;
	ret['started'] = cfg_start;
	ret['uptime'] = start - cfg_start;

	ret['cfg_http_port'] = cfg_http_port;

	ret['cfg_aggregators'] = {};
	for (key in cfg_aggregators) {
		obj = cfg_aggregators[key];
		ret['cfg_aggregators'][key] = {
		    hostname: obj.cag_hostname,
		    routekey: obj.cag_routekey,
		    http_port: obj.cag_http_port,
		    transformations: obj.cag_transformations,
		    ninsts: obj.cag_ninsts,
		    insts: Object.keys(obj.cag_insts)
		};
	}

	ret['cfg_instrumenters'] = {};
	for (key in cfg_instrumenters) {
		obj = cfg_instrumenters[key];

		ret['cfg_instrumenters'][key] = {
		    hostname: obj.ins_hostname,
		    routekey: obj.ins_routekey,
		    nmetrics_avail: obj.ins_nmetrics_avail,
		    insts: Object.keys(obj.ins_insts)
		};

		ret['cfg_instrumenters'][key]['ninsts'] =
		    ret['cfg_instrumenters'][key]['insts'].length;
	}

	ret['cfg_insts'] = {};
	for (key in cfg_insts) {
		obj = cfg_insts[key].inst;

		ret['cfg_insts'][key] = caDeepCopy(obj.properties());
		ret['cfg_insts'][key]['aggregator'] =
		    obj.aggregator().cag_hostname;
		ret['cfg_insts'][key]['custid'] = obj.custid();
	}

	ret['instn-scopes'] = {};
	ret['instn-scopes']['global'] = Object.keys(cfgInstrumentations());
	for (key in cfg_customers)
		ret['instn-scopes']['cust:' + key] =
		    Object.keys(cfgInstrumentations(key));

	if (!recurse)
		return (checkdone());

	/*
	 * The user wants information about each related service.  We make a
	 * subrequest to each one and store the results in our return value.
	 */
	ASSERT.ok(timeout && typeof (timeout) == typeof (0));
	doamqp = function (type, hostname) {
		return (function (err, result) {
			if (err)
				ret[type][hostname] = { error: err };
			else
				ret[type][hostname] = result.s_status;

			checkdone();
		});
	};

	ret['aggregators'] = {};
	for (key in cfg_aggregators) {
		obj = cfg_aggregators[key];
		ret['aggregators'][key] = { error: 'timed out' };
		nrequests++;
		cfg_cap.cmdStatus(obj.cag_routekey, timeout,
		    doamqp('aggregators', key));
	}

	ret['instrumenters'] = {};
	for (key in cfg_instrumenters) {
		obj = cfg_instrumenters[key];
		ret['instrumenters'][key] = { error: 'timed out' };
		nrequests++;
		cfg_cap.cmdStatus(obj.ins_routekey, timeout,
		    doamqp('instrumenters', key));
	}

	return (checkdone());
}

var cfgHttpStatusParams = {
	recurse: {
		type: 'boolean',
		default: false
	},
	timeout: {
		type: 'number',
		default: 5, /* sec */
		min: 1,
		max: 60
	}
};

/*
 * Handle GET /ca/admin/status
 */
function cfgHttpAdminStatus(request, response)
{
	var recurse, timeout;

	try {
		recurse = mod_ca.caHttpParam(cfgHttpStatusParams,
		    request.ca_params, 'recurse');
		timeout = mod_ca.caHttpParam(cfgHttpStatusParams,
		    request.ca_params, 'timeout');
	} catch (ex) {
		if (!(ex instanceof caValidationError))
			throw (ex);

		response.send(HTTP.EBADREQUEST, ex);
		return;
	}

	cfgAdminStatus(function (result) {
		response.send(HTTP.OK, result);
	}, recurse, timeout * 1000);
}

/*
 * Handle GET /ca/metrics
 */
function cfgHttpMetricsList(request, response)
{
	response.send(HTTP.OK, cfg_statmods);
}

/*
 * Handle GET /ca/[customers/:custid]/transformations
 */
function cfgHttpTransformsList(request, response)
{
	response.send(HTTP.OK, cfg_transformations);
}

/*
 * Handle GET /ca/[customers/:custid]/instrumentations
 */
function cfgHttpInstrumentationsList(request, response)
{
	var custid = request.params['custid'];
	var rv = [];

	cfgInstrumentationsListCustomer(rv, cfgInstrumentations(custid));

	if (custid === undefined) {
		for (custid in cfg_customers)
			cfgInstrumentationsListCustomer(rv,
			    cfgInstrumentations(custid));
	}

	response.send(HTTP.OK, rv);
}

function cfgInstrumentationsListCustomer(rv, insts)
{
	var instid;

	for (instid in insts)
		rv.push(cfg_insts[instid].inst.properties());
}

/*
 * Handle POST /ca/[customers/:custid]/instrumentations
 */
function cfgHttpInstCreate(request, response)
{
	var custid, props;

	custid = request.params['custid'];
	props = cfgHttpInstReadProps(request);
	cfg_log.info('request to instrument:\n%j', props);
	cfg_factory.create(custid, props, function (err, inst) {
		var headers, code;

		if (err) {
			code = err instanceof caError &&
			    err.code() == ECA_INVAL ? HTTP.EBADREQUEST :
			    HTTP.ESERVER;
			response.send(code, { error: err.message });
			return;
		}

		props = inst.properties();
		headers = { 'Location': props['uri'] };
		cfg_insts[inst.fqid()] = { inst: inst };
		cfgInstrumentations(inst.custid())[inst.fqid()] = true;
		response.send(HTTP.CREATED, props, headers);
	});
}

/*
 * Read instrumentation properties from either form fields or the body (JSON).
 */
function cfgHttpInstReadProps(request)
{
	var actuals, props, fields, ii;

	/*
	 * If the user specified a JSON object, we use that.  Otherwise, we
	 * assume they specified parameters in form fields.
	 */
	if (request.ca_json && typeof (request.ca_json) == typeof ({}))
		actuals = request.ca_json;
	else
		actuals = request.ca_params;

	props = {};
	fields = [ 'module', 'stat', 'predicate', 'decomposition', 'enabled',
	    'retention-time' ];

	for (ii = 0; ii < fields.length; ii++) {
		if (fields[ii] in actuals)
			props[fields[ii]] = actuals[fields[ii]];
	}

	return (props);
}

/*
 * Handle DELETE /ca/[customers/:custid]/instrumentation/:instid
 */
function cfgHttpInstDelete(request, response)
{
	var custid = request.params['custid'];
	var instid = request.params['instid'];
	var fqid = mod_ca.caQualifiedId(custid, instid);
	var inst;

	if (!(fqid in cfg_insts)) {
		response.send(HTTP.ENOTFOUND);
		return;
	}

	/*
	 * We always complete this request immediately and successfully since we
	 * can always pretend we don't have this thing any more even if we
	 * failed to disable some instrumenters.  We don't even need to wait for
	 * the commands to complete.
	 */
	inst = cfg_insts[fqid];
	delete (cfgInstrumentations(custid)[fqid]);
	delete (cfg_insts[fqid]);
	response.send(HTTP.OK);

	cfg_factory.destroy(inst.inst, function (err) {
		if (!err)
			return;

		cfg_log.error('failure during instrumentation delete: %r', err);
	});
}

/*
 * Handle PUT /ca/[customers/:custid]/instrumentation/:instid
 */
function cfgHttpInstSetProperties(request, response)
{
	var custid = request.params['custid'];
	var instid = request.params['instid'];
	var fqid = mod_ca.caQualifiedId(custid, instid);
	var inst, props;

	if (!(fqid in cfg_insts)) {
		response.send(HTTP.ENOTFOUND);
		return;
	}

	inst = cfg_insts[fqid];
	props = cfgHttpInstReadProps(request);
	cfg_factory.setProperties(inst.inst, props, function (err) {
		if (err)
			return (response.send(
			    HTTP.EBADREQUEST, { error: err.message }));
		return (response.send(HTTP.OK, inst.inst.properties()));
	});
}

/*
 * Handle GET /ca/[customers/:custid]/instrumentation/:instid
 */
function cfgHttpInstGetProperties(request, response)
{
	var custid = request.params['custid'];
	var instid = request.params['instid'];
	var fqid = mod_ca.caQualifiedId(custid, instid);

	if (!(fqid in cfg_insts)) {
		response.send(HTTP.ENOTFOUND);
		return;
	}

	response.send(HTTP.OK, cfg_insts[fqid].inst.properties());
}

/*
 * Handle GET /ca/[customers/:custid]/instrumentation/:instid/value...
 */
function cfgHttpInstValue(request, response)
{
	var custid = request.params['custid'];
	var instid = request.params['instid'];
	var fqid = mod_ca.caQualifiedId(custid, instid);
	var inst, port;

	if (!(fqid in cfg_insts)) {
		response.send(HTTP.ENOTFOUND);
		return;
	}

	inst = cfg_insts[fqid];
	port = inst.inst.aggregator().cag_http_port;
	ASSERT.ok(port);
	mod_cahttp.caHttpForward(request, response, '127.0.0.1', port, cfg_log);
}

/*
 * Handle AMQP "ping" message
 */
function cfgCmdPing(msg)
{
	cfg_cap.sendCmdAckPing(msg.ca_source, msg.ca_id);
}

/*
 * Handle AMQP "status" message
 */
function cfgCmdStatus(msg)
{
	var key, inst, agg;
	var sendmsg = {};

	sendmsg.s_component = 'config';

	sendmsg.s_instrumenters = [];
	for (key in cfg_instrumenters) {
		inst = cfg_instrumenters[key];
		sendmsg.s_instrumenters.push({
		    sii_hostname: inst.ins_hostname,
		    sii_nmetrics_avail: inst.ins_nmetrics_avail,
		    sii_ninsts: inst.ins_ninsts
		});
	}

	sendmsg.s_aggregators = [];
	for (key in cfg_aggregators) {
		agg = cfg_aggregators[key];
		sendmsg.s_aggregators.push({
		    sia_hostname: agg.cag_hostname,
		    sia_ninsts: agg.cag_ninsts
		});
	}

	cfg_cap.sendCmdAckStatus(msg.ca_source, msg.ca_id, sendmsg);
}

/*
 * Handle AMQP "aggregator online" message
 */
function cfgNotifyAggregatorOnline(msg)
{
	var id, agg, action, trans;

	if (!('ag_http_port' in msg)) {
		cfg_log.warn('ignoring aggonline msg with no port: %j', msg);
		return;
	}

	if (!('ag_transformations' in msg)) {
		cfg_log.warn('ignoring aggonline msg with no ' +
		    'transformations: %j', msg);
		return;
	}


	if (msg.ca_hostname in cfg_aggregators) {
		agg = cfg_aggregators[msg.ca_hostname];
		action = 'restarted';
	} else {
		agg = cfg_aggregators[msg.ca_hostname] = {};
		action = 'started';
		agg.cag_ninsts = 0;
		agg.cag_insts = {};
	}

	agg.cag_hostname = msg.ca_hostname;
	agg.cag_routekey = msg.ca_source;
	agg.cag_agent_name = msg.ca_agent_name;
	agg.cag_agent_version = msg.ca_agent_version;
	agg.cag_os_name = msg.ca_os_name;
	agg.cag_os_release = msg.ca_os_release;
	agg.cag_os_revision = msg.ca_os_revision;
	agg.cag_http_port = msg.ag_http_port;
	agg.cag_transformations = msg.ag_transformations;

	for (trans in agg.cag_transformations) {
		if (!(trans in cfg_transformations))
			cfg_transformations[trans] =
			    agg.cag_transformations[trans];
	}

	for (id in agg.cag_insts)
		cfg_factory.reenableAggregator(cfg_insts[id].inst);

	cfg_log.info('aggregator %s: %s', action, msg.ca_hostname);
}

/*
 * Handle AMQP "instrumenter online" message
 */
function cfgNotifyInstrumenterOnline(msg)
{
	var inst, action;
	var mod, mstats, stat, mfields, field;
	var mm, ss, ff, id;

	if (msg.ca_hostname in cfg_instrumenters) {
		inst = cfg_instrumenters[msg.ca_hostname];
		action = 'restarted';
	} else {
		inst = cfg_instrumenters[msg.ca_hostname] = {};
		action = 'started';
		inst.ins_insts = {};
		inst.ins_ninsts = 0;
	}

	inst.ins_hostname = msg.ca_hostname;
	inst.ins_routekey = msg.ca_source;
	inst.ins_agent_name = msg.ca_agent_name;
	inst.ins_agent_version = msg.ca_agent_version;
	inst.ins_os_name = msg.ca_os_name;
	inst.ins_os_release = msg.ca_os_release;
	inst.ins_os_revision = msg.ca_os_revision;
	inst.ins_nmetrics_avail = 0;

	for (mm = 0; mm < msg.ca_modules.length; mm++) {
		mod = msg.ca_modules[mm];

		if (!(mod.cam_name in cfg_statmods)) {
			cfg_statmods[mod.cam_name] = {
				stats: {},
				label: mod.cam_description
			};
		}

		mstats = cfg_statmods[mod.cam_name]['stats'];
		inst.ins_nmetrics_avail += mod.cam_stats.length;

		for (ss = 0; ss < mod.cam_stats.length; ss++) {
			stat = mod.cam_stats[ss];
			if (!(stat.cas_name in mstats)) {
				mstats[stat.cas_name] = {
				    label: stat.cas_description,
				    type: stat.cas_type,
				    fields: {}
				};
			}

			mfields = mstats[stat.cas_name]['fields'];

			for (ff = 0; ff < stat.cas_fields.length; ff++) {
				field = stat.cas_fields[ff];

				if (!(field.caf_name in mfields)) {
					mfields[field.caf_name] = {
					    type: field.caf_type,
					    label: field.caf_description
					};
				}
			}
		}
	}

	for (id in inst.ins_insts) {
		cfg_factory.enableInstrumenter(cfg_insts[id].inst,
		    inst, function (err) {
			if (err) {
				cfg_log.error('failed to reenable "%s" on ' +
				    '"%s": %r', id, inst.ins_hostname, err);
			}
		    });
	}

	cfg_log.info('instrumenter %s: %s', action, msg.ca_hostname);
}

/*
 * Handle AMQP "log" message
 */
function cfgNotifyLog(msg)
{
	if (!('l_message' in msg)) {
		cfg_log.warn('dropped log message with missing message');
		return;
	}

	cfg_log.warn('from %s: %s %s', msg.ca_hostname, msg.ca_time,
	    msg.l_message);
}

/*
 * Handle AMQP "asynchronous instrumenter error" message
 */
function cfgNotifyInstrumenterError(msg)
{
	if (!('ins_inst_id' in msg) || !('ins_error' in msg) ||
	    !('ins_status' in msg) ||
	    (msg['status'] != 'enabled' && msg['status'] != 'disabled')) {
		cfg_log.warn('dropping malformed inst error message');
		return;
	}

	if (!(msg.ca_hostname in cfg_instrumenters)) {
		cfg_log.warn('dropping inst error message for unknown host ' +
		    '"%s"', msg.ca_hostname);
		return;
	}

	/* XXX */
}

main();
