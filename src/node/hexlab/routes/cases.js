// © https://github.com/scherma
// contact http_error_418@unsafehex.com

var express = require('express');
var router = express.Router();
var db = require('../lib/database');
var options = require('../lib/options');
var functions = require('../lib/functions');
var moment = require('moment');
var format = require('string-template');
const path = require('path');
var rootdir = path.join('/usr/local/unsafehex', options.conf.site.name);
var fdir = path.join(rootdir, 'suspects');
var casesdir = path.join(rootdir, 'output');
var mainmenu = require('../lib/mainmenu');
var fs = require('fs');
var Promise = require('bluebird');
var glob = require('glob');
var xml2js = require('xml2js');


router.get('/', function(req, res, next) {
	var p = 0;
	var w = {};
	var d = true;
	var l = 20;
	
	if (req.query.fname) { w.fname = req.query.fname; }
	if (req.query.sha256) { w.sha256 = req.query.sha256; }
	if (req.query.page) { p = parseInt(req.query.page); }
	if (req.query.desc == "false") { d = false; }
	if (req.query.limit) { l = parseInt(req.query.limit); }
	
	var extra = l + 1;
	
	db.list_cases(page=p, desc=d, where=w, limit=extra).then(function(dbres) {
		var buildQuery = function(w, p, l, d) {
			var params = Array();
			if (w.sha256) {	params.push("sha256=" + w.sha256); }
			if (w.fname) { params.push("fname=" + w.fname); }
			if (p) { params.push("page=" + p); }
			if (d === false) { params.push("desc=false"); }
			if (l) { params.push("limit=" + l); }
			
			return params.join("&");
		};
		
		var nxt = '';
		var prv = '';
		if (dbres.length > l) {
			nxt = '/cases?' + buildQuery(w, p + 1, l, d);
			dbres.pop();
		}
		if (page > 0) {
			prv = '/cases?' + buildQuery(w, p - 1, l, d);
		}
		res.render('cases', {cases: dbres, mainmenu: mainmenu, next: nxt, prev: prv});
	});
});

router.post('/start', function(req, res, next) {
	functions.Suspect(req.body.filename, req.body.sha256, fdir, req.body.interactive, req.body.banking, req.body.web, parseInt(req.body.reboots), parseInt(req.body.runtime))
	.then(function(suspect) {
		var s = db.new_case(suspect.uuid, suspect.submittime, suspect.hashes.sha256, suspect.fname)
		.then(function() {
			return suspect;
		});
		return s;
	})
	.then(functions.QueueSuspect)
	.then(function(suspect) {
		res.redirect(format('/cases/view/{sha256}/{uuid}', {sha256: req.body.sha256, uuid: suspect.uuid}));
	})
	.catch(function(err) {
		console.log(err);
		res.redirect('/cases?error=true');
	});
	
});

/*router.get('/view/:sha256', function(req, res, next) {
	var sha256 = req.params.sha256;
	res.redirect('/files?sha256=${sha256}');
});*/

router.get('/view/:sha256/:uuid', function(req,res,next) {
	var shortdir = req.params.sha256.substring(0,2);
	var casepath = path.join(casesdir, shortdir, req.params.sha256, req.params.uuid);
	var uuidshort = req.params.uuid.substr(0,2);
	var imagepath = path.join(rootdir, 'www', options.conf.site.name, 'public', 'images', 'cases', uuidshort, req.params.uuid);
	var imagepublicpath = path.join('/images', 'cases', uuidshort, req.params.uuid);
	
	/*var rawpropertiesP = new Promise((fulfill, reject) => {
		fs.readFile(path.join(casepath, 'properties.json'), 'utf8', (err, data) => {
			if (err === null) {
				fulfill(JSON.parse(data));	
			} else {
				reject(err);
			}
		});
	});*/
	
	var sysmonP = new Promise((fulfill, reject)=> {
		var xmlp = xml2js.Parser();
		fs.readFile(path.join(casepath, 'sysmon.xml'), 'utf8', (err, data) => {
			if (err === null) {
				// this is only parsing a single event - need to update so it parses all events
				xmlp.parseString(data, (err, parsedxml) => {
					if (err === null) {
						fulfill(parsedxml);
					} else {
						console.log(format("Unable to provide sysmon events: {err}", {err: err}));
						fulfill({});
					}
				});
			} else {
				console.log(format("Unable to provide sysmon events: {err}", {err: err}));
				fulfill({});
			}
		});
	});
	
	var eventsP = new Promise((fulfill, reject) => {
		fs.readFile(path.join(casepath, 'eve.json'), 'utf8', (err, data) => {
			if (err === null) {
				try {
					var d = JSON.parse(data);
					Object.keys(d).forEach(function(key){
						d[key].forEach(function(event, i){
							if (functions.ofInterest(event)) {
								d[key][i].interesting = true;
							} else {
								d[key][i].interesting = false;
							}
						});
					});
					fulfill(d);
				} catch(err) {
					console.log(err);
					fulfill({});
				}
			} else {
				console.log(format("Unable to provide suricata events: {err}", {err: err}));
				fulfill({});
			}
		});
	});
	
	var pcapsummaryP = new Promise((fulfill, reject) => {
		fs.readFile(path.join(casepath, 'pcap_summary.json'), 'utf8', (err, data) => {
			if (err === null) {
				try {
					var d = JSON.parse(data);
					var result = [];
					d.forEach(function(evt){
						var e = {src_ip: evt.src, dest_ip: evt.dst};
						if (functions.ofInterest(e)) {
							result.push(evt);
						}
					});
					fulfill(result);
				} catch (e) {
					console.log(e);
					fulfill({});
				}
			} else {
				console.log(format("Unable to provide pcap summary: {err}", {err: err}));
				fulfill({});
			}
		});
	});
	
	var runlogP = new Promise((fulfill, reject) => {
		fs.readFile(path.join(casepath, 'run.log'), 'utf8', (err, data) => {
			if (err === null) {
				fulfill(data);	
			} else {
				console.log(format("Unable to provide pcap summary: {err}", {err: err}));
				fulfill("");
			}
		});
	});
	
	var screenshots = new Promise((fulfill, reject) => {
		var images = Array();
		if (fs.existsSync(imagepath)) {
			var pattern = "+([0-9]).png";
			glob(pattern, {cwd: imagepath}, function(er, files) {
				files.forEach(file => {
					var thisimagepath = path.join(imagepublicpath, file);
					var testthumbpath = path.join(imagepath, file.replace(/\.png$/, "-thumb.png"));
					var publicthumbpath = path.join(imagepublicpath, file.replace(/\.png$/, "-thumb.png"));
					var thumbpath = thisimagepath;
					if (fs.existsSync(testthumbpath)) {
						thumbpath = publicthumbpath;
					}
					var image = {path: thisimagepath, alt: '', thumb: thumbpath};
					images.push(image);
				});
				console.log(format("Found {num} images", {num: images.length}));
				fulfill(images);
			});
		} else {
			console.log("No images");
			fulfill([]);
		}

	});
	
	var thiscase = db.show_case(req.params.uuid);
	
	Promise.all([eventsP, sysmonP, pcapsummaryP, runlogP, thiscase, screenshots])
	.then((values) => {
		var events = values[0];
		var rawsysmon = values[1];
		var pcapsummary = values[2];
		var runlog = values[3];
		var suspect = values[4][0];
		var images = values[5];
		var properties = {};
                var showmagic = suspect.magic;
                if (suspect.magic.length > 50) {
                    showmagic = suspect.magic.substr(0, 50) + "...";
                }
		properties.fname = {name: "File name", text: suspect.fname};
		properties.avresult = {name: "Clam AV result", text: suspect.avresult};
		properties.mimetype = {name: "File MIME type", text: showmagic, "class": "mime", htmltitle: suspect.magic};
		properties.submittime = {name: "Submit time", text: suspect.submittime};
		properties.starttime = {name: "Run start time", text: suspect.starttime};
		properties.endtime = {name: "Run end time", text: suspect.endtime};
		properties.status = {name: "Status", text: suspect.status};
		properties.sha256 = {name: "SHA256", text: suspect.sha256};
		properties.sha1 = {name: "SHA1", text: suspect.sha1};
		properties.os = {name: "VM OS", text: suspect.vm_os};
		properties.uuid = {name: "Run UUID", text: suspect.uuid};
		properties.params = {name: "Parameters", text: "Reboots: " + suspect.reboots + ", Banking interaction: " + suspect.banking + ", Web interaction: " + suspect.web};
		//var shortdir = suspect.uuid.substr(0,2);
		
		var caseid = properties.sha256.text + "/" + properties.uuid.text;
		
		var sysmon = [];
		if (rawsysmon.Events && rawsysmon.Events.Event) {
			rawsysmon.Events.Event.forEach((object) => {
				sysmon.push(functions.ParseSysmon(object));
			});
		}
		//var screenshot = {path: path.join('/images/cases', shortdir, properties["Run UUID"], '1.png'), alt: ''};
		
		var pcaplink = '/cases/pcap/' + properties.sha256.text + '/' + properties.uuid.text;
		
		
		var caseobj = {
			mainmenu: mainmenu,
			properties: properties,
			screenshots: images,
			suricata: events,
			sysmon: sysmon,
			pcaplink: pcaplink,
			pcapsummary: pcapsummary,
			runlog: runlog,
			caseid: caseid
		};
		
		res.render('case', caseobj);
	})
	.catch((err) => {
		// for debug; remove when live
		res.render('error', {error: err});
	});
});

router.get('/pcap/:sha256/:uuid', function(req,res,next) {
	var sd = req.params.sha256.substring(0,2);
	var fpath = path.join(casesdir, sd, req.params.sha256, req.params.uuid, 'capture.pcap');
	var sha256 = req.params.sha256;
	var fname = sha256 + '-capture.pcap';
	res.download(fpath, fname);
});

router.get('/:sha256/delete/:uuid', function(req,res,next) {
	var cancel = "/cases";
	var c = {sha256: req.params.sha256, uuid: req.params.uuid};
	res.render('deletecase', {mainmenu: mainmenu, c: c, cancel: cancel});
});

router.post('/:sha256/delete/:uuid', function(req,res,next) {
	var re = new RegExp('\\w{8}-\\w{4}-\\w{4}-\\w{4}-\\w{12}');
	if (!re.test(req.params.uuid)) {
		res.status(400);
		res.send('Invalid UUID');
	} else {
		if (req.body.purge) {
			var sd = req.params.sha256.substring(0,2);
			var casedir = path.join(casesdir, sd, req.params.sha256, req.params.uuid);
			var imagedir = path.join(rootdir, 'www', options.conf.site.name, 'public', 'images', 'cases', sd, req.params.uuid);
			functions.deleteFolderRecursive(casedir);
			functions.deleteFolderRecursive(imagedir);
		}
		db.delete_case(req.params.uuid)
		.then(res.redirect('/cases?sha256=' + req.params.sha256));
	}
});

router.get('/properties/:sha256/:uuid', function(req, res, next) {
	db.show_case(req.params.uuid)
	.then((result) => {
		res.status(200);
		res.send(result[0]);
	});
});

router.get('/runlog/:sha256/:uuid', function(req, res, next){
	var shortdir = req.params.sha256.substring(0,2);
	var casepath = path.join(casesdir, shortdir, req.params.sha256, req.params.uuid);
	var runlogP = new Promise((fulfill, reject) => {
		fs.readFile(path.join(casepath, 'run.log'), 'utf8', (err, data) => {
			if (err === null) {
				fulfill(data);	
			} else {
				console.log(format("Unable to provide pcap summary: {err}", {err: err}));
				fulfill("");
			}
		});
	});
	
	runlogP.then((result) => {
		res.status(200);
		res.send(result);
	});
});

module.exports = router;
