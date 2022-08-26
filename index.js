var express = require('express');
var app = express();
var http = require('http');
app.use(express.static('public'));
app.get("/", function(req, res){
	res.render("../index.ejs");
});
app.get("/call/:id", function(req, res){
    res.render("call.ejs?call-id=" + req.params.id);
});
app.get("/call", function(req, res){
	res.render("call.ejs");
});
app.get("/thank", function(req, res){
    res.render("thank.ejs");
});

var server = http.createServer(app);
let port=process.env.PORT || 1234;
server.listen( port,()=>console.log(`server running at http://localhost:${port}/`));
