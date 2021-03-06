var events = require('events').EventEmitter;
var url = require('url');
var bodyParser = require('body-parser');
var compression = require('compression');

var middleware = require('./middleware');
var ratelimit = require('./ratelimit');
var Auth = require('./auth');

var ApiQuick = function () {};

ApiQuick.prototype = {

    // Constants
    error: 'error',
    warn: 'warn',
    info: 'info',

    /**
     * Initializes the api server
     * @param port: An optional port for the server to listen to, default: 8080
     * @param extra: An optional dict containing extra settings for the api server
     */
    init: function(port, extra) {
        var self = this;
        if(!extra) extra = {};

        this.logger = new events();
        this.middleware = new middleware();
        this.rateLimit = new ratelimit();

        if(extra.compress) {
            this.use(compression());
        }

        // Handle the rate limits with middleware
        if(extra.rateLimit) {
            this.rateLimit.startRateLimit(extra.rateLimit);
            this.use(function (req, res, next) {
                if (!self.rateLimit.handleRateLimit(req.connection.remoteAddress)) {
                    // Rate limit reached
                    self._writeResponse({ok: false, code: 429, error: 'Rate limit reached'});
                } else {
                    next();
                }
            });
        }

        this.use(bodyParser.json());
        this.use(bodyParser.urlencoded({
            extended: true
        }));

        this.use(function(req, res, next) {
            res.removeHeader('X-Powered-By');
            next();
        });

        // Init vars
        this.routes = {};
        this.checkAuth = false;
        this.ssl = false;
        this.options = {};
        this.port = port || 8080;
        this.prettyJson = false;
        this.consoleLog = 4;  // Log everything
        this.maxDepth = 1;
        this.debug = false;
        this.fullRequest = false;

        // Deal with extra settings
        if(extra.ssl && extra.ssl.key && extra.ssl.cert) {
            var fs = require('fs');
            this.ssl = true;
            this.options.key = fs.readFileSync(extra.ssl.key);
            this.options.cert = fs.readFileSync(extra.ssl.cert);
        }
        if(extra.prettyJson !== undefined) {
            this.prettyJson = extra.prettyJson;
        }
        if(extra.maxDepth !== undefined) {
            this.maxDepth = extra.maxDepth;
        }
        if(extra.debug) {
            this.debug = extra.debug;
        }
        if(extra.fullRequest !== undefined) {
            this.fullRequest = extra.fullRequest;
        }
        if(extra.consoleLog !== undefined) {
            this.consoleLog = extra.consoleLog;
        }

        if(this.consoleLog) {
            this._startConsoleLogging(this.consoleLog);
        }

        // Start the server
        if(this.ssl) {
            require('https').createServer(this.options, this._process()).listen(this.port);
        } else {
            require('http').createServer(this._process()).listen(this.port);
        }

        this.logger.emit('info', 'Listening to port ' + this.port, {});

        return this;
    },

    _startConsoleLogging: function(level) {
        // Convert a string debug value to an int value for easy comparison
        switch(level) {
            case 'error':
                level = 8;
                break;
            case 'warn':
                level = 6;
                break;
            case 'info':
                level = 4;
                break;
            case true:
                level = 2;
                break;
            default: // Leave it as it is
        }

        if(level <= 8) {
            this.logger.on(this.error, function(msg, data) {
                console.log('ERROR    ', new Date().toISOString(), '    ', msg, data);
            });
        }
        if(level <= 6) {
            this.logger.on(this.warn, function(msg, data) {
                console.log('WARN     ', new Date().toISOString(), '    ', msg, data);
            });
        }
        if(level <= 4) {
            this.logger.on(this.info, function(msg, data) {
                console.log('INFO     ', new Date().toISOString(), '    ', msg, data);
            });
        }
    },

    /**
     * Add express compatible middleware to the api server that will run for every connection
     * @param f: A function to run for every connection before it is handled by the api server
     *                 Function is given the parameters req, res, next.
     *                req: Express request object
     *                res: Express response object
     *                next: Callback function
     */
    use: function(f) {
        this.middleware.add(f);
    },

    /**
     * Add a listener for api server events
     * @params type: Type of event to listen for ('error', 'warn', 'info')
     */
    on: function(type, f) {
        this.logger.on(type, f);
    },

    /**
     * Adds a single specified endpoint to the api server
     * @deprecated: To be removed for v1.0.0
     * @param name: The first component of the endpoint url
     * @param p: The rest of the package dict
     * @param extra: Extra settings information for the provided dict
     */
    addPackage: function (name, p, extra) {
        var endPoints = {};
        endPoints[name] = p;
        this.addEndpoints(endPoints, extra);
    },

    /**
     * Takes a potentially multi-layer dict of functions and adds them as endpoints to the api server
     * Replaces addPackage
     * @param route: A potentially multi-layer dict of functions
     * @param extra: An optional dict of options to apply to the provided endpoints
     */
    addEndpoints: function(route, extra) {
        var stack = [];
        var self = this;
        function _r(d) {
            for(var k in d) {
                stack.push(k);
                if(typeof d[k] == 'function') {
                    if(extra && extra.auth) {
                        d[k].auth = extra.auth;
                    }
                    self.routes['/' + stack.join('/')] = d[k];
                } else if(typeof d[k] == 'object'){
                    //It's a dict to recursively search deeper
                    _r(d[k]);
                }
                stack.pop();
            }
        }

        _r(route);
    },

    /**
     * Takes a request object and checks that it has a valid handler
     * Will also return the handler if one can be found
     * @param req: The request object
     * @returns: A dict with an ok & code parameter and optionally an error string or a handler function
     */
    _checkParamsSupplied: function(req) {
        var endpoint = req.u.pathname;
        if(endpoint[endpoint.length-1] == '/') {
            // remove the end slash
            endpoint = endpoint.substring(0, endpoint.length-1);
        }

        var returnDict = {
            ok: false,
            code: 404,
            error: "No endpoint " + endpoint
        };

        var args = [];
        var depth = 0;

        // Look down the endpoint url until a valid handler is found
        // This is expensive when there is no handler so keep maxDepth as low as possible
        while(!returnDict.ok && depth <= this.maxDepth) {
            if(this.routes[endpoint]) {
                returnDict.ok = true;
                returnDict.handler = this.routes[endpoint];
                returnDict.handler.auth = returnDict.handler && returnDict.handler.auth
                returnDict.args = args;
                returnDict.error = undefined;
            } else {
                depth++;
                if(depth > this.maxDepth) break; // No point doing any more we have reached the limit
                var endIndex = endpoint.lastIndexOf('/');
                if(endIndex !== 0) {
                    args.unshift(endpoint.substring(endIndex+1, endpoint.length))
                    endpoint = endpoint.substring(0, endpoint.lastIndexOf('/'));
                } else {
                    break;
                }
            }
        }
        return returnDict
    },

    /**
     * Returns the headers that should be added when sending the provided data
     * @param data: The data that the header will be sent with
     */
    _getHeaders: function(data) {
        var header = {
            'content-type' : 'application/json',
            'X-Content-Type-Options': 'nosniff',
            'X-Frame-Options': 'DENY'
        };
        if(data && data.code == 401) {
            // Message was an auth fail so we want to give a hint on how to auth
            header['WWW-Authenticate'] =  'Basic user:pass';
        }
        return header;
    },

    _checkAuthDetails: function(handler_auth, authDetails, cb) {
        if(handler_auth) {
            return handler_auth(authDetails.user, authDetails.pass, cb);
        } else if(handler_auth === false) {
            // Authentication specifically disabled for this package
        } else if(this.checkAuth) {
            return this.checkAuth(authDetails.user, authDetails.pass, cb);
        }
        return cb(true);  // Default allow
    },

    /**
     * Writes the provided data into the response and closes the connection
     * @param res: Response object to write the data to
     * @param data: The data to reply with. Optionally data.code will be used as the response code and
     *                 data.error or data.msg will be used as the status message.
     * @returns: 
     */
    _writeResponse: function(res, data, extra) {
        if(!data) data = '' + data;
        if(!extra) extra = {};
        var header = this._getHeaders(data);
        var statusMsg = extra.status || data.error || data.msg || 'success';
        var code = extra.code || data.code || 200;
        if(this.debug && extra.e && data.e === undefined) {
            data.e = extra.e.stack || (''+extra.e);
        }
        var data_string;
        if(this.prettyJson) {
            data_string = JSON.stringify(data, null, 2);
        } else {
            data_string = JSON.stringify(data);
        }

        this.logger.emit(this.info, 'Making ' + code + ' response', data);

        res.writeHead(code, statusMsg, header);
        return res.end(data_string);
    },

    _getRequestData: function(req) {
        if(this.fullRequest) {
            req.ip = req.connection.remoteAddress;
            return req;
        } else {
            return {
                method: req.method,
                args: req.args,
                body: req.body,
                ip: req.connection.remoteAddress
            }
        }
    },

    /**
     * Creates a handler for processing an incoming data packet
     * @param method: A string indicating the type of call we will handle, eg. 'GET' or 'POST'
     * @param getData: A function that given a request will return the provided data from the client
     * @returns: Returns a function that takes a request and response object and replies to the client
     */
    _process: function() {
        var self = this;
        return function(req, res) {
            try {
                self.middleware.run(req, res, function() {
                    if(req.method == 'GET') {
                        req.u = url.parse(req.url, true);
                        req.body = req.u.query;
                    } else {
                        req.u = url.parse(req.url, false);
                    }

                    var responseData = self._checkParamsSupplied(req);

                    if(!responseData.ok) {
                        return self._writeResponse(res, responseData);
                    }

                    var handler = responseData.handler;
                    req.args = responseData.args;
                    var authDetails = Auth.decodeAuthDetails(req.headers.authorization);

                    self._checkAuthDetails(handler.auth, authDetails, function(auth) {
                        if(!auth) {
                            return self._writeResponse(res, {code: 401, ok: false, error: "Auth failed"});
                        }

                        // If we are still ok up to here then we can let the handler respond
                        setTimeout(function() {
                            try{
                                if(handler.length >= 2) {
                                    // Handler takes a callback so run asynchronously
                                    handler(self._getRequestData(req), function(err, result, extra) {
                                        if(err && extra.e === undefined) {
                                            extra.e = err;
                                        }
                                        self._writeResponse(res, result, extra);
                                    });
                                } else {
                                    // Handler doesn't take a callback so run synchronously
                                    var result = handler(self._getRequestData(req));
                                    self._writeResponse(res, result);
                                }
                            } catch(e) {
                                self.logger.emit(self.warn, 'Uncaught exception in handler', {e: e});
                                self._writeResponse(res, {
                                    ok: false,
                                    code: 500,
                                    error: ''+e
                                }, {e: e});
                            }
                        }, 0);
                    });
                });
            } catch(e) {
                // Something has gone wrong! Reply to the user with a generic error
                self.logger.emit(self.error, 'Uncaught exception', {e: e, stack: e.stack});
                self._writeResponse(res, {
                    ok: false,
                    code: 500,
                    error: ''+e
                }, {e: e});
            }
        };
    },

    /**
     * Sets the global authentication function
     * @param f: The function to use to authenticate requests globally
     */
    auth: function(f) {
        this.checkAuth = f;
    },

    /**
     * Set the server to authenticate based on a dict of valid username->password mappings
     * @param credentials: A dict of username->password mappings, the password value can be a string or a list of strings
     */
    authByJson: function(credentials) {
        var auth_function = Auth.authByJsonFunction(credentials);
        // Convert to "async" function and set the server to auth using it
        this.auth(function(u, p, cb) {
            var r = auth_function(u, p);
            cb(r);
        });
    }
};

// Deprecated function names to be replaced in version 1.0.0
ApiQuick.prototype.getBasicHeader = ApiQuick.prototype._getHeaders;
ApiQuick.prototype.handleRateLimitHelper = function(ip) {
    return this.rateLimit.handleRateLimit(ip);
};

module.exports = new ApiQuick();
