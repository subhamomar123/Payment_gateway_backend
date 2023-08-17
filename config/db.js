const mysql = require('mysql2');

const con = mysql.createConnection({
    host:'localhost',
    user:'root',
    password:'',
    database: 'revapp'
})

con.connect(function(err){
    if(err) {
        console.log(err);
    } else {
        console.log("connected");
    }
})

module.exports = con;