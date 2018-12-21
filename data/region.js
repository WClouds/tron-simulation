const { regionModel } = require('./connection');

async function regionFind(args){
   
    const query = args.query || { };

    /* If ID is specified, utilize cache */
    if (args.id) { return stash.find({_id:args.id}); }

    return await regionModel.find(query);
}

module.exports={
    regionFind
}