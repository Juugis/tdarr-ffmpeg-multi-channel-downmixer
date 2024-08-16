const details = () => ({
	id: "Plugin_Audio_Downmix",
	Stage: "Pre-processing",
	Name: "Downmix Audio to Stereo",
	Type: "Audio",
	Operation: "Transcode",
	Description:
		"This plugin downmixes all audio tracks with more than 2 channels to stereo and applies dynamic range compression.",
	Version: "1.02",
	Tags: "ffmpeg",
	Inputs: [
		{
			name: "base",
			type: "number",
			defaultValue: 1.0,
			inputUI: {
				type: "text",
			},
			tooltip:
				"Specify the base amplification factor for the front left (FL) and front right (FR) channels. Default is 1.0.",
		},
		{
			name: "rear",
			type: "number",
			defaultValue: 0.75,
			inputUI: {
				type: "text",
			},
			tooltip:
				"Specify the amplification factor for the rear channels (BL and BR). Default is 0.75.",
		},
		{
			name: "speech",
			type: "number",
			defaultValue: 1.25,
			inputUI: {
				type: "text",
			},
			tooltip:
				"Specify the amplification factor for the center channel (FC), usually carrying speech. Default is 1.25.",
		},
		{
			name: "codec",
			type: "string",
			defaultValue: "aac",
			inputUI: {
				type: "text",
			},
			tooltip:
				"Specify the codec for the downmixed stereo audio tracks. Default is aac.",
		},
		{
			name: "remove_stereo_tracks",
			type: "boolean",
			defaultValue: false,
			inputUI: {
				type: "checkbox",
			},
			tooltip:
				"Remove stereo audio tracks if they exist.",
		},
	],
});

const plugin = (file, librarySettings, inputs, otherArguments) => {
	inputs = require("../methods/lib")().loadDefaultValues(inputs, details);
	const { base, rear, speech, codec, remove_stereo_tracks } = inputs;
	const response = {
		processFile: false,
		preset: "",
		handBrakeMode: false,
		FFmpegMode: true,
		reQueueAfter: true,
		infoLog: "",
		container: `.${file.container}`,
		processMessage: undefined, // A log of the operations carried out
	};

	const job_id = otherArguments.job.jobId;
	const job_id_metadata = file.ffProbeData.format.tags?.JOB_ID;
	const all_audio_tracks = file.ffProbeData.streams.filter((stream) => stream.codec_type === "audio");
	const audio_tracks = (remove_stereo_tracks)? all_audio_tracks.filter((track) => track.channels > 2): all_audio_tracks;
    const audio_track_starts_with_index = audio_tracks.reduce((min, track) => Math.min(min, track.index), all_audio_tracks[0].index);
	const process_audio_tracks = [];

	const getDownmixedStereoTrackName = (audio_track) => {
		const new_audio_track_template = "{title}_{channels}_{language}_stereo";
		const title = (audio_track.tags?.title)? audio_track.tags.title: "na";
		const channels = (audio_track?.channels)? audio_track.channels: "na";
		const language = (audio_track.tags?.language)? audio_track.tags.language: "na";
		return new_audio_track_template.replace("{title}", title).replace("{channels}", channels).replace("{language}", language);
	};

	const findDownmixedStereoTrack = (audio_track) => {
		const downmixed_stereo_track_name = getDownmixedStereoTrackName(audio_track);
		console.log(`searching for track name: ${downmixed_stereo_track_name}`);
		console.log(`in tracks: ${all_audio_tracks.map((track) => track.tags.title).join(", ")}`);
		const downmixed_stereo_track = all_audio_tracks.find((track) => track.tags.title === downmixed_stereo_track_name);
		return downmixed_stereo_track;
	};

	const getInfoLog = (msg) => {
		return `
			msg: ${msg} \n
			process_audio_tracks: ${process_audio_tracks.map((track) => track.tags.title).join(", ")} \n
			audio_tracks: ${JSON.stringify(audio_tracks, null, 2)} \n
		`;
	};

	for (const audio_track of audio_tracks) {
		if (audio_track.channels && audio_track.channels > 2) {
			// check if downmixed stereo track already exists
			// should not process if downmixed stereo track already exists and remove_stereo_tracks is false
			const downmixed_stereo_track = findDownmixedStereoTrack(audio_track);
			if (downmixed_stereo_track && !remove_stereo_tracks) {
				console.log("Downmixed stereo track already exists, skipping");
				continue;
			}
			// downmixed stereo track does not exist, add to process list
			process_audio_tracks.push(audio_track);
		}
	}

	if (process_audio_tracks.length === 0) {
		// throw error if no surround sound tracks found
		response.infoLog = getInfoLog("No surround sound tracks found, skipping");
		response.processMessage = "No surround sound tracks found, skipping";
		return response;
	}

	// build ffmpeg command and add job_id tag
	let ffmpeg_command = `<io> -map 0:v -map 0:s? -map 0:d? -map 0:t? -map 0:m? -vcodec copy -scodec copy -metadata JOB_ID=${job_id}`;

	// add downmixed stereo audio tracks, use -filter_complex to genereate new audio track
	for (const [index, audio_track] of process_audio_tracks.entries()) {
		const new_audio_index = index;
		const audio_track_index = audio_track.index - audio_track_starts_with_index;
		const language = audio_track.tags.language;
		const title = getDownmixedStereoTrackName(audio_track);

		ffmpeg_command += ` -filter_complex "[0:a:${audio_track_index}]dynaudnorm,pan=stereo|FL=${base}*FL+${speech}*FC+${rear}*BL|FR=${base}*FR+${speech}*FC+${rear}*BR[a${new_audio_index}]"`;
		ffmpeg_command += ` -map "[a${new_audio_index}]"`;
		ffmpeg_command += ` -codec:a:${new_audio_index} ${codec}`;
		ffmpeg_command += ` -metadata:s:a:${new_audio_index} "title=${title}"`;
		ffmpeg_command += ` -metadata:s:a:${new_audio_index} "codec=${codec}"`;
		ffmpeg_command += ` -metadata:s:a:${new_audio_index} "channels=2"`;
		ffmpeg_command += ` -metadata:s:a:${new_audio_index} "channel_layout=stereo"`;
		ffmpeg_command += ` -metadata:s:a:${new_audio_index} "index=${new_audio_index}"`;
		if(language) ffmpeg_command += ` -metadata:s:a:${new_audio_index} "language=${language}"`;
	}

	for (const [index, audio_track] of audio_tracks.entries()) {
		const new_audio_index = index + process_audio_tracks.length;
		const audio_track_index = audio_track.index - audio_track_starts_with_index;
		ffmpeg_command += ` -map 0:a:${audio_track_index} -codec:a:${new_audio_index} ${codec}`;
	}

	// should only process file once
	if(job_id_metadata === job_id) {
		response.infoLog = getInfoLog(`job_id tag already exists, skipping`);
		response.processMessage = "job_id tag already exists, skipping";
		return response;
	}

	response.processFile = true;
	response.infoLog = getInfoLog(`Found ${process_audio_tracks.length} surround sound tracks, processing, ffmpeg_command: ${ffmpeg_command}`);
	response.preset = ffmpeg_command;
	console.log(ffmpeg_command);
	return response;
};

module.exports.details = details;
module.exports.plugin = plugin;